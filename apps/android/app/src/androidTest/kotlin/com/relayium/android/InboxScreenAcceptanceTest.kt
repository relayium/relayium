package com.relayium.android

import android.content.res.Configuration
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import com.relayium.android.inbox.InboxAccountId
import com.relayium.android.inbox.InboxConversation
import com.relayium.android.inbox.InboxConversationEntry
import com.relayium.android.inbox.InboxDeviceRow
import com.relayium.android.inbox.InboxDirectoryState
import com.relayium.android.inbox.InboxKeyHealth
import com.relayium.android.inbox.InboxKeyRow
import com.relayium.android.inbox.InboxModel
import com.relayium.android.inbox.InboxReceiving
import com.relayium.android.inbox.InboxSendCoordinator
import com.relayium.android.inbox.InboxSendStatus
import com.relayium.android.inbox.InboxSendTarget
import com.relayium.android.inbox.InboxTargetBlock
import com.relayium.android.inbox.InboxTargetEligibility
import com.relayium.android.inbox.InboxTaskRow
import com.relayium.android.ui.InboxActions
import com.relayium.android.ui.InboxScreen
import com.relayium.android.ui.RelayiumTheme
import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxAutoAccept
import com.relayium.protocol.inbox.InboxCapability
import com.relayium.protocol.inbox.InboxKeyMaterial
import com.relayium.protocol.inbox.InboxManifestKind
import com.relayium.protocol.inbox.InboxProtocol
import java.io.File
import java.util.Collections
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The real Inbox surface, composed on a device, driven by its visible
 * affordances.
 *
 * STANDALONE on purpose: no navigation, no ViewModel, no host Activity of the
 * app's own — this composes `InboxScreen` against real state values and real
 * action callbacks, which is exactly the seam the final host will construct.
 * What it therefore proves is that the surface renders every state and that its
 * controls act; it does NOT prove the eventual navigation, SAF or share-target
 * integration, which is a separate gate with a separate harness.
 *
 * The host here is one vertically-scrolling column, which is how
 * `RelayiumApp` hosts the other three surfaces — so `performScrollTo` on every
 * control is also the check that nothing is unreachable at a small width or a
 * large font.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class InboxScreenAcceptanceTest {

    @get:Rule
    val compose = createComposeRule()

    /**
     * The device is actually rendering at the configuration the harness asked
     * for.
     *
     * `wm density`, `settings put system font_scale` and `cmd uimode night` can
     * each be ACCEPTED and not applied — a density that a display refuses, a
     * font scale a device policy overrides, a night mode a battery saver owns.
     * A matrix that asserted only what it requested would then report narrow,
     * large-font, dark coverage it never had.
     *
     * A `@Before` rather than another test, so the group's count is the number
     * of behaviours it covers. Each argument is optional: a run that supplies
     * none asserts nothing, which is what makes this class runnable from an IDE.
     */
    @Before
    fun theDeviceMatchesTheRequestedConfiguration() {
        val args = InstrumentationRegistry.getArguments()
        val configuration = context.resources.configuration

        args.getString("relayium.smallestWidthDp")?.takeIf { it.isNotBlank() }?.let { requested ->
            assertTrue(
                "requested $requested dp smallest width, device reports " +
                    "${configuration.smallestScreenWidthDp}",
                configuration.smallestScreenWidthDp <= requested.toInt(),
            )
        }
        args.getString("relayium.fontScale")?.takeIf { it.isNotBlank() }?.let { requested ->
            assertEquals(
                "requested font scale $requested, device reports ${configuration.fontScale}",
                requested.toFloat(),
                configuration.fontScale,
                0.01f,
            )
        }
        args.getString("relayium.night")?.takeIf { it == "yes" || it == "no" }?.let { requested ->
            val night = configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
                Configuration.UI_MODE_NIGHT_YES
            assertEquals(
                "requested night=$requested, device uiMode=${configuration.uiMode}",
                requested == "yes",
                night,
            )
        }
    }

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun s(id: Int) = context.getString(id)
    private fun s(id: Int, vararg args: Any) = context.getString(id, *args)

    private val account = InboxAccountId("0000111122223333444455556666aaaa")
    private val authority = InboxModel.Authority(account, 1)
    private val peerId = "fedcba9876543210fedcba9876543210"
    private val otherId = "cccccccccccccccccccccccccccccccc"
    private val taskId = "11112222333344445555666677778888"

    // ── wire fixtures ───────────────────────────────────────────────────────

    private val publicKey: String =
        InboxKeyMaterial.encode(InboxKeyMaterial.generateKeyPair().publicKey)

    private fun keyDocument() = Json.obj(
        "ID" to Json.of("aaaabbbbccccddddeeeeffff00001111"),
        "Algorithm" to Json.of(InboxProtocol.KEY_ALGORITHM),
        "PublicKey" to Json.of(publicKey),
        "Generation" to Json.of(1L),
        "CreatedAt" to Json.of(1_700_000_000L),
        "SupersededAt" to Json.of(0L),
        "RevokedAt" to Json.of(0L),
    )

    private fun enrolment(
        autoAccept: String = "auto",
        capabilities: List<String> = listOf(
            InboxCapability.RECEIVE_V3,
            InboxCapability.AUTO_ACCEPT_V1,
            InboxCapability.RESUME_V1,
            InboxCapability.TEXT_V1,
        ),
        key: Json? = keyDocument(),
    ): Json.Obj {
        val fields = linkedMapOf<String, Json>(
            "Presence" to Json.of("online"),
            "LastHeartbeatAt" to Json.of(1_700_000_000L),
            "PresenceExpiresAt" to Json.of(1_700_000_090L),
            "HeartbeatIntervalSeconds" to Json.of(30),
            "ProtocolVersion" to Json.of(3),
            "Capabilities" to Json.arr(capabilities.map { Json.of(it) }),
            "ReceiveCapability" to Json.of(InboxCapability.RECEIVE_V3),
            "AutoAccept" to Json.of(autoAccept),
            "ReceiveDirReady" to Json.of(true),
            "Revoked" to Json.of(false),
            "CanReceive" to Json.of(true),
            "RegisteredAt" to Json.of(1_699_000_000L),
        )
        if (key != null) fields["Key"] = key
        return Json.Obj(fields)
    }

    private fun device(
        id: String,
        name: String,
        current: Boolean = false,
        inbox: Json? = enrolment(),
    ): InboxDeviceRow {
        val fields = linkedMapOf<String, Json>(
            "ID" to Json.of(id),
            "Name" to Json.of(name),
            "Kind" to Json.of("android"),
            "Current" to Json.of(current),
        )
        if (inbox != null) fields["Inbox"] = inbox
        return InboxDeviceRow.read(Json.Obj(fields))
    }

    private fun target(row: InboxDeviceRow): InboxSendTarget =
        requireNotNull(InboxTargetEligibility.target(row)) { "fixture is not sendable" }

    private fun task(): InboxTaskRow = InboxTaskRow.read(
        Json.obj(
            "ID" to Json.of(taskId),
            "TargetDeviceID" to Json.of("0123456789abcdef0123456789abcdef"),
            "SourceDeviceID" to Json.of(peerId),
            "IdempotencyKey" to Json.of("idem-1"),
            "StoredFileID" to Json.of("99998888777766665555444433332222"),
            "State" to Json.of("attention_required"),
            "ErrorCode" to Json.of(""),
            "CiphertextBytes" to Json.of(2_048L),
            "WrapAlgorithm" to Json.of(InboxProtocol.KEY_ALGORITHM),
            "TargetKeyID" to Json.of("aaaabbbbccccddddeeeeffff00001111"),
            "TargetKeyGeneration" to Json.of(1L),
            "Attempts" to Json.of(0L),
            "NextAttemptAt" to Json.of(0L),
            "LeaseExpiresAt" to Json.of(0L),
            "CreatedAt" to Json.of(1_700_000_000L),
            "UpdatedAt" to Json.of(1_700_000_000L),
            "ExpiresAt" to Json.of(1_700_600_000L),
            "NotifiedAt" to Json.of(0L),
            "SavedAt" to Json.of(0L),
            "TerminalAt" to Json.of(0L),
            "Terminal" to Json.of(false),
        ),
    )

    private fun ready(
        peer: InboxDeviceRow = device(peerId, "MacBook"),
    ) = InboxModel.State(
        authority = authority,
        ready = true,
        deviceName = "Pixel",
        policy = InboxAutoAccept.OFF,
        receiving = InboxReceiving.OFF,
        devices = listOf(target(peer)),
        textCapableDevices = setOf(peer.id),
        directory = InboxDirectoryState.Ready(File("/tmp")),
    )

    // ── harness ─────────────────────────────────────────────────────────────

    private class Recorder {
        val calls: MutableList<String> = Collections.synchronizedList(ArrayList())
        fun record(call: String) = calls.add(call)
        fun saw(call: String) = calls.contains(call)
    }

    private fun host(
        state: InboxModel.State,
        actions: InboxActions,
        content: @Composable (InboxModel.State) -> Unit = {},
    ) {
        compose.setContent {
            RelayiumTheme {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp),
                ) {
                    InboxScreen(state, actions)
                    content(state)
                }
            }
        }
    }

    /**
     * A CONTROL, matched by its label and by the fact that it is a control.
     *
     * A heading and a button can legitimately carry the same word — in
     * Simplified Chinese a "接收" section over a "接收" button — and a text-only
     * selector cannot tell them apart, so it fails in one language and not the
     * other for a reason that has nothing to do with the product. Matching the
     * click semantics as well as the text is what makes this independent of the
     * copy. A DISABLED button still carries its click action and is matched
     * here, which is what lets a disabled assertion stay an assertion rather
     * than becoming the selector.
     */
    private fun control(id: Int) = control(s(id))

    private fun control(label: String) =
        compose.onNode(hasText(label) and hasClickAction())

    /**
     * A control INSIDE the open dialog.
     *
     * A confirmation legitimately repeats the label of the control that opened
     * it — "Delete" on the row and "Delete" in the dialog is the ordinary
     * pattern, and changing the copy so a selector can tell them apart would be
     * letting the automation write the product. The dialog is a real ancestor in
     * the semantics tree, so scoping to it is the honest disambiguation.
     */
    private fun dialogControl(id: Int) = compose.onNode(
        hasText(s(id)) and hasClickAction() and hasAnyAncestor(isDialog()),
    )

    private fun clickText(id: Int) = control(id).performScrollTo().performClick()

    // ── entry states ────────────────────────────────────────────────────────

    @Test
    fun signedOutOffersOneAction() {
        val recorder = Recorder()
        host(InboxModel.State(), InboxActions(signIn = { recorder.record("signIn") }))

        compose.onNodeWithText(s(R.string.inbox_signed_out_body)).assertIsDisplayed()
        clickText(R.string.inbox_signed_out_action)
        assertTrue(recorder.saw("signIn"))
    }

    /** A first load that failed shows the reason and a retry — never a spinner
     *  that runs forever. */
    @Test
    fun aFailedFirstLoadOffersRetry() {
        val recorder = Recorder()
        host(
            InboxModel.State(
                authority = authority,
                failure = InboxModel.State.Failure.NETWORK,
            ),
            InboxActions(retry = { recorder.record("retry") }),
        )

        compose.onNodeWithText(s(R.string.inbox_error_network)).assertIsDisplayed()
        clickText(R.string.inbox_retry)
        assertTrue(recorder.saw("retry"))
    }

    /** A build central refuses is not fixed by asking again, so no retry is
     *  offered for it. */
    @Test
    fun anUnsupportedBuildIsNotOfferedARetry() {
        host(
            ready().copy(failure = InboxModel.State.Failure.UNSUPPORTED_BUILD),
            InboxActions(),
        )
        compose.onNodeWithText(s(R.string.inbox_error_unsupported_build)).performScrollTo()
            .assertIsDisplayed()
        compose.onNodeWithText(s(R.string.inbox_retry)).assertDoesNotExist()
    }

    // ── receiving ───────────────────────────────────────────────────────────

    /** The policy and the BEHAVIOUR are rendered separately, and the surface
     *  states plainly that it does not receive in the background. */
    @Test
    fun theSurfaceNeverPromisesBackgroundDelivery() {
        val recorder = Recorder()
        host(
            ready().copy(policy = InboxAutoAccept.AUTO, receiving = InboxReceiving.STOPPED),
            InboxActions(setPolicy = { recorder.record("policy:${it.wire}") }),
        )

        compose.onNodeWithText(s(R.string.inbox_foreground_note)).performScrollTo()
            .assertIsDisplayed()
        compose.onNodeWithText(s(R.string.inbox_state_stopped)).performScrollTo()
            .assertIsDisplayed()
        clickText(R.string.inbox_policy_off)
        assertTrue(recorder.saw("policy:off"))
    }

    /** An unusable container says which problem it is, because each has a
     *  different remedy. */
    @Test
    fun anUnusableContainerNamesTheProblem() {
        host(
            ready().copy(
                policy = InboxAutoAccept.AUTO,
                receiving = InboxReceiving.UNAVAILABLE,
                directory = InboxDirectoryState.Unavailable(
                    InboxDirectoryState.Unavailable.Problem.DISK_FULL,
                ),
            ),
            InboxActions(),
        )
        compose.onNodeWithText(s(R.string.inbox_directory_full)).performScrollTo()
            .assertIsDisplayed()
    }

    // ── keys ────────────────────────────────────────────────────────────────

    /** The repair states what it COSTS before it happens, and only acts on
     *  confirmation. */
    @Test
    fun aKeyRepairIsConfirmedBeforeItRuns() {
        val recorder = Recorder()
        host(
            ready().copy(
                keyHealth = InboxKeyHealth.NeedsRepair(
                    InboxKeyHealth.NeedsRepair.Reason.REMOTE_KEY_NOT_HELD,
                    "aaaabbbbccccddddeeeeffff00001111",
                    1,
                ),
            ),
            InboxActions(repairKey = { recorder.record("repair") }),
        )

        compose.onNodeWithText(s(R.string.inbox_key_not_held)).performScrollTo().assertIsDisplayed()
        clickText(R.string.inbox_key_repair_action)
        compose.onNodeWithText(s(R.string.inbox_key_repair_confirm_body)).assertIsDisplayed()
        assertTrue("nothing runs before confirmation", recorder.calls.isEmpty())
        dialogControl(R.string.inbox_key_repair_confirm_action).performClick()
        assertTrue(recorder.saw("repair"))
    }

    /** An ambiguous remote history offers no repair: choosing between two active
     *  keys would mean this build naming an identity the protocol never did. */
    @Test
    fun anAmbiguousKeyHistoryOffersNoRepair() {
        host(
            ready().copy(
                keyHealth = InboxKeyHealth.NeedsRepair(
                    InboxKeyHealth.NeedsRepair.Reason.REMOTE_KEY_AMBIGUOUS, "", 0,
                ),
            ),
            InboxActions(repairKey = { throw AssertionError("no repair may be offered") }),
        )
        compose.onNodeWithText(s(R.string.inbox_key_ambiguous)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(s(R.string.inbox_key_repair_action)).assertDoesNotExist()
    }

    // ── the ask queue ───────────────────────────────────────────────────────

    @Test
    fun aHeldDeliveryIsAnsweredByThePerson() {
        val recorder = Recorder()
        host(
            ready().copy(policy = InboxAutoAccept.ASK, awaitingAnswer = listOf(task())),
            InboxActions(respond = { id, accept -> recorder.record("respond:$id:$accept") }),
        )

        compose.onNodeWithText(s(R.string.inbox_pending_title)).performScrollTo().assertIsDisplayed()
        clickText(R.string.inbox_pending_decline)
        assertTrue(recorder.saw("respond:$taskId:false"))
    }

    /** An answer in flight cannot be double-tapped. */
    @Test
    fun anAnswerInFlightDisablesItsControls() {
        host(
            ready().copy(awaitingAnswer = listOf(task()), answering = setOf(taskId)),
            InboxActions(),
        )
        control(R.string.inbox_pending_accept).performScrollTo().assertIsNotEnabled()
    }

    // ── devices and sending ─────────────────────────────────────────────────

    /** A blocked device is shown WITH its reason rather than hidden. */
    @Test
    fun aBlockedDeviceKeepsItsReason() {
        val blocked = device(otherId, "Old phone", inbox = null)
        host(
            ready().copy(blockedDevices = listOf(blocked to InboxTargetBlock.NOT_ENROLLED)),
            InboxActions(),
        )
        compose.onNodeWithText("Old phone").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(s(R.string.inbox_block_not_enrolled)).performScrollTo()
            .assertIsDisplayed()
    }

    @Test
    fun choosingADeviceRevealsItsSendControls() {
        val recorder = Recorder()
        host(
            ready(),
            InboxActions(
                chooseFiles = { recorder.record("files:${it.deviceId}") },
                sendText = { t, text -> recorder.record("text:${t.deviceId}:$text") },
            ),
        )

        control("MacBook").performScrollTo().performClick()
        compose.onNodeWithText(s(R.string.inbox_send_to, "MacBook")).performScrollTo()
            .assertIsDisplayed()

        clickText(R.string.inbox_send_choose_files)
        assertTrue(recorder.saw("files:$peerId"))

        compose.onNode(hasSetTextAction()).performScrollTo().performTextInput("four o'clock")
        clickText(R.string.inbox_send_message)
        assertTrue(recorder.saw("text:$peerId:four o'clock"))
    }

    /** A device that cannot present a message is not offered one: a `.txt`
     *  facsimile is exactly what this feature refuses. */
    @Test
    fun aDeviceThatCannotShowMessagesIsNotOfferedOne() {
        val peer = device(
            peerId,
            "MacBook",
            inbox = enrolment(
                capabilities = listOf(
                    InboxCapability.RECEIVE_V3,
                    InboxCapability.AUTO_ACCEPT_V1,
                    InboxCapability.RESUME_V1,
                ),
            ),
        )
        host(ready(peer).copy(textCapableDevices = emptySet()), InboxActions())

        control("MacBook").performScrollTo().performClick()
        compose.onNodeWithText(s(R.string.inbox_send_no_text)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(s(R.string.inbox_send_message)).assertDoesNotExist()
    }

    // ── outgoing ────────────────────────────────────────────────────────────

    /** An uncertain outcome says so, and its retry is offered as safe. */
    @Test
    fun anAmbiguousSendIsDescribedHonestly() {
        val recorder = Recorder()
        host(
            ready().copy(
                sends = listOf(
                    InboxSendStatus(
                        jobId = "job00000000000000000000000001",
                        targetDeviceId = peerId,
                        kind = InboxManifestKind.FILE,
                        names = listOf("report.pdf"),
                        totalBytes = 2_400_000,
                        phase = InboxSendStatus.Phase.STOPPED,
                        stop = InboxSendCoordinator.Result.Reason.TRANSPORT,
                        ambiguous = true,
                    ),
                ),
            ),
            InboxActions(send = { recorder.record("send:$it") }),
        )

        compose.onNodeWithText(s(R.string.inbox_stop_transport)).performScrollTo()
            .assertIsDisplayed()
        compose.onNodeWithText(s(R.string.inbox_sending_ambiguous)).performScrollTo()
            .assertIsDisplayed()
        clickText(R.string.inbox_sending_retry)
        assertTrue(recorder.saw("send:job00000000000000000000000001"))
    }

    @Test
    fun aSendInFlightCanBeStopped() {
        val recorder = Recorder()
        host(
            ready().copy(
                sends = listOf(
                    InboxSendStatus(
                        jobId = "job00000000000000000000000001",
                        targetDeviceId = peerId,
                        kind = InboxManifestKind.TEXT,
                        names = emptyList(),
                        totalBytes = 12,
                        phase = InboxSendStatus.Phase.SENDING,
                    ),
                ),
            ),
            InboxActions(cancelSend = { recorder.record("cancel:$it") }),
        )
        clickText(R.string.inbox_sending_cancel)
        assertTrue(recorder.saw("cancel:job00000000000000000000000001"))
    }

    // ── history ─────────────────────────────────────────────────────────────

    private fun receivedFiles(directory: String? = "/tmp/received/task") = InboxConversationEntry(
        id = taskId,
        peerDeviceId = peerId,
        direction = InboxConversationEntry.Direction.RECEIVED,
        kind = InboxConversationEntry.Kind.FILES,
        names = listOf("report.pdf"),
        byteCount = 2_400_000,
        at = 1_700_000_400,
        directory = directory,
    )

    private fun conversationOf(vararg entries: InboxConversationEntry) =
        InboxConversation(peerDeviceId = peerId, entries = entries.toList())

    /** Opening a conversation marks exactly the entries that were SHOWN. */
    @Test
    fun openingAConversationMarksWhatWasShown() {
        val recorder = Recorder()
        host(
            ready().copy(conversations = listOf(conversationOf(receivedFiles()))),
            InboxActions(markRead = { recorder.record("read:${it.joinToString(",")}") }),
        )

        clickText(R.string.inbox_history_open)
        compose.waitForIdle()
        assertTrue(recorder.saw("read:$taskId"))
        compose.onNodeWithText("report.pdf").performScrollTo().assertIsDisplayed()
    }

    /** Deleting states that it is LOCAL, and only acts on confirmation. */
    @Test
    fun deletingIsLocalAndConfirmed() {
        val recorder = Recorder()
        host(
            ready().copy(conversations = listOf(conversationOf(receivedFiles()))),
            InboxActions(delete = { recorder.record("delete:${it.joinToString(",")}") }),
        )

        clickText(R.string.inbox_history_open)
        // The row's own control: no dialog exists yet, so this is unambiguous.
        clickText(R.string.inbox_delete_action)
        compose.onNodeWithText(s(R.string.inbox_delete_body)).assertIsDisplayed()
        assertTrue("nothing is deleted before confirmation", recorder.calls.isEmpty())
        // And now the one inside the dialog, which shares that label by design.
        dialogControl(R.string.inbox_delete_action).performClick()
        assertTrue(recorder.saw("delete:$taskId"))
    }

    /**
     * Open, export and share appear only when the host wired them AND the entry
     * actually published files. A control that cannot act is worse than none.
     */
    @Test
    fun systemActionsAppearOnlyWhenTheyCanAct() {
        val recorder = Recorder()
        host(
            ready().copy(conversations = listOf(conversationOf(receivedFiles()))),
            InboxActions(
                open = { recorder.record("open:${it.id}") },
                share = { recorder.record("share:${it.id}") },
            ),
        )

        clickText(R.string.inbox_history_open)
        clickText(R.string.inbox_action_open)
        assertTrue(recorder.saw("open:$taskId"))
        compose.onNodeWithText(s(R.string.inbox_action_share)).performScrollTo().assertIsDisplayed()
        // No export handler was supplied, so no export control exists.
        compose.onNodeWithText(s(R.string.inbox_action_export)).assertDoesNotExist()
    }

    @Test
    fun anEntryWithNoPublishedFilesOffersNoSystemActions() {
        host(
            ready().copy(conversations = listOf(conversationOf(receivedFiles(directory = null)))),
            InboxActions(open = { throw AssertionError("nothing to open") }),
        )
        clickText(R.string.inbox_history_open)
        compose.onNodeWithText(s(R.string.inbox_action_open)).assertDoesNotExist()
    }

    /** A message body is fetched on demand, in either direction. */
    @Test
    fun aMessageBodyIsLoadedOnDemand() {
        val sent = InboxConversationEntry(
            id = "job00000000000000000000000001",
            peerDeviceId = peerId,
            direction = InboxConversationEntry.Direction.SENT,
            kind = InboxConversationEntry.Kind.MESSAGE,
            names = emptyList(),
            byteCount = 24,
            at = 1_700_000_300,
            sentState = InboxConversationEntry.SentState.SAVED,
        )
        host(
            ready().copy(conversations = listOf(conversationOf(sent))),
            InboxActions(loadMessage = { if (it.id == sent.id) "the meeting moved to four" else null }),
        )

        clickText(R.string.inbox_history_open)
        compose.waitForIdle()
        compose.onNodeWithText("the meeting moved to four").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(s(R.string.inbox_sent_saved)).performScrollTo().assertIsDisplayed()
    }

    /** A body that is genuinely gone says so, rather than loading forever. */
    @Test
    fun aMissingMessageBodySaysSo() {
        val received = InboxConversationEntry(
            id = taskId,
            peerDeviceId = peerId,
            direction = InboxConversationEntry.Direction.RECEIVED,
            kind = InboxConversationEntry.Kind.MESSAGE,
            names = emptyList(),
            byteCount = 5,
            at = 1_700_000_300,
        )
        host(
            ready().copy(conversations = listOf(conversationOf(received))),
            InboxActions(loadMessage = { null }),
        )

        clickText(R.string.inbox_history_open)
        compose.waitForIdle()
        compose.onNodeWithText(s(R.string.inbox_entry_message_unavailable)).performScrollTo()
            .assertIsDisplayed()
    }

    /**
     * The SAME entry id under a new authority is a different message.
     *
     * Ids are unique within an account and not across them. The surface is keyed
     * on the authority, so an account switch reloads rather than leaving the
     * previous account's body on screen.
     */
    @Test
    fun anAccountSwitchReloadsABodyUnderARepeatedId() {
        val entry = InboxConversationEntry(
            id = taskId,
            peerDeviceId = peerId,
            direction = InboxConversationEntry.Direction.RECEIVED,
            kind = InboxConversationEntry.Kind.MESSAGE,
            names = emptyList(),
            byteCount = 5,
            at = 1_700_000_300,
        )
        var current by mutableStateOf(
            ready().copy(conversations = listOf(conversationOf(entry))),
        )
        val bodies = Collections.synchronizedList(ArrayList<InboxModel.Authority?>())
        compose.setContent {
            RelayiumTheme {
                Column(
                    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
                ) {
                    val shown = current
                    InboxScreen(
                        shown,
                        InboxActions(
                            loadMessage = {
                                bodies.add(shown.authority)
                                if (shown.authority == authority) "first account" else "second account"
                            },
                        ),
                    )
                }
            }
        }

        clickText(R.string.inbox_history_open)
        compose.waitForIdle()
        compose.onNodeWithText("first account").performScrollTo().assertIsDisplayed()

        val second = InboxModel.Authority(InboxAccountId("9999888877776666555544443333bbbb"), 2)
        current = current.copy(
            authority = second,
            conversations = listOf(conversationOf(entry)),
        )
        compose.waitForIdle()

        // The selection is part of what the authority key resets, so the
        // conversation has to be reopened — and the body reloaded — under the
        // new account.
        clickText(R.string.inbox_history_open)
        compose.waitForIdle()
        compose.onNodeWithText("second account").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("first account").assertDoesNotExist()
        assertEquals(listOf(authority, second), bodies.toList())
    }

    /** The surface states what app-data removal costs. */
    @Test
    fun theSurfaceStatesWhatLocalRemovalCosts() {
        host(ready(), InboxActions())
        compose.onNodeWithText(s(R.string.inbox_storage_note)).performScrollTo().assertIsDisplayed()
    }
}
