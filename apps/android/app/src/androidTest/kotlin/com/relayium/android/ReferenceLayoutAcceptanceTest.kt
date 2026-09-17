package com.relayium.android

import android.content.Context
import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.relayium.android.account.AccountState
import com.relayium.android.account.DevicesState
import com.relayium.android.account.KeystoreTokenStore
import com.relayium.android.inbox.InboxAccountId
import com.relayium.android.inbox.InboxConversation
import com.relayium.android.inbox.InboxConversationEntry
import com.relayium.android.inbox.InboxDeviceRow
import com.relayium.android.inbox.InboxDirectoryState
import com.relayium.android.inbox.InboxModel
import com.relayium.android.inbox.InboxReceiving
import com.relayium.android.inbox.InboxSendTarget
import com.relayium.android.inbox.InboxTargetEligibility
import com.relayium.android.ui.InboxActions
import com.relayium.android.ui.InboxScreen
import com.relayium.android.ui.Metrics
import com.relayium.android.ui.RelayiumTheme
import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxCapability
import com.relayium.protocol.inbox.InboxKeyMaterial
import com.relayium.protocol.inbox.InboxProtocol
import java.io.File
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * **The reference layout, as behaviour rather than as copy.**
 *
 * This file checks the structure the owner's macOS reference asks for — one
 * caption over a quiet group, a row that keeps its own facts inside itself, a
 * reading column that stops before the edge of a tablet — and it checks it by
 * measuring the composed tree. Nothing here asserts that a particular sentence
 * is present: a string assertion would only mirror the source it was written
 * from, and would pass just as happily on a layout that put every fact in the
 * wrong place.
 *
 * Two classes, because they need two different truths:
 *
 *  * [ReferenceLayoutAcceptanceTest] composes the REAL `InboxScreen` against
 *    real state values and real callbacks — the fixture seam the feature's own
 *    acceptance already uses — and measures grouping, containment and the
 *    disclosures a person actually operates.
 *  * [ReferenceAccountLayoutAcceptanceTest] drives the REAL `MainActivity`
 *    against a real account on this run's disposable server, because the
 *    signed-in Account surface is the one this work regrouped and a fake state
 *    hook would be a picture of an object the user never touches.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class ReferenceLayoutAcceptanceTest {

    @get:Rule
    val compose = createComposeRule()

    /**
     * The context the COMPOSITION is using, captured from inside `setContent`.
     *
     * Every string this class expects is resolved through it, so a run under a
     * per-app locale asserts the language that is actually being drawn rather
     * than whatever the instrumentation process happens to hold.
     */
    private var rendering: Context? = null
    private val context: Context
        get() = rendering ?: InstrumentationRegistry.getInstrumentation().targetContext

    // ── fixtures ────────────────────────────────────────────────────────────

    private val account = InboxAccountId("0000111122223333444455556666aaaa")
    private val authority = InboxModel.Authority(account, 1)
    private val peerId = "fedcba9876543210fedcba9876543210"
    private val otherId = "cccccccccccccccccccccccccccccccc"

    private val publicKey: String =
        InboxKeyMaterial.encode(InboxKeyMaterial.generateKeyPair().publicKey)

    /** `ask` rather than `auto`, so the target carries a real caveat: the row
     *  under test is the one that has something extra to keep inside it. */
    private fun device(id: String, name: String, autoAccept: String = "ask"): InboxDeviceRow =
        InboxDeviceRow.read(
            Json.obj(
                "ID" to Json.of(id),
                "Name" to Json.of(name),
                "Kind" to Json.of("android"),
                "Current" to Json.of(false),
                "Inbox" to Json.obj(
                    "Presence" to Json.of("online"),
                    "LastHeartbeatAt" to Json.of(1_700_000_000L),
                    "PresenceExpiresAt" to Json.of(1_700_000_090L),
                    "HeartbeatIntervalSeconds" to Json.of(30),
                    "ProtocolVersion" to Json.of(3),
                    "Capabilities" to Json.arr(
                        listOf(
                            InboxCapability.RECEIVE_V3,
                            InboxCapability.AUTO_ACCEPT_V1,
                            InboxCapability.TEXT_V1,
                        ).map { Json.of(it) },
                    ),
                    "ReceiveCapability" to Json.of(InboxCapability.RECEIVE_V3),
                    "AutoAccept" to Json.of(autoAccept),
                    "ReceiveDirReady" to Json.of(true),
                    "Revoked" to Json.of(false),
                    "CanReceive" to Json.of(true),
                    "RegisteredAt" to Json.of(1_699_000_000L),
                    "Key" to Json.obj(
                        "ID" to Json.of("aaaabbbbccccddddeeeeffff00001111"),
                        "Algorithm" to Json.of(InboxProtocol.KEY_ALGORITHM),
                        "PublicKey" to Json.of(publicKey),
                        "Generation" to Json.of(1L),
                        "CreatedAt" to Json.of(1_700_000_000L),
                        "SupersededAt" to Json.of(0L),
                        "RevokedAt" to Json.of(0L),
                    ),
                ),
            ),
        )

    private fun target(row: InboxDeviceRow): InboxSendTarget =
        requireNotNull(InboxTargetEligibility.target(row)) { "fixture is not sendable" }

    private fun entry(id: String) = InboxConversationEntry(
        id = id,
        peerDeviceId = peerId,
        direction = InboxConversationEntry.Direction.RECEIVED,
        kind = InboxConversationEntry.Kind.FILES,
        names = listOf("report.pdf"),
        byteCount = 4_096L,
        at = 1_700_000_100L,
        readAt = 1_700_000_200L,
    )

    /** A surface with something in every group, which is the only state in
     *  which grouping can be measured at all. */
    private fun populated(): InboxModel.State {
        val peer = device(peerId, "MacBook")
        val other = device(otherId, "Pixel Tablet", autoAccept = "auto")
        return InboxModel.State(
            authority = authority,
            ready = true,
            deviceName = "Pixel",
            policy = com.relayium.protocol.inbox.InboxAutoAccept.ASK,
            receiving = InboxReceiving.LISTENING,
            devices = listOf(target(peer), target(other)),
            textCapableDevices = setOf(peer.id, other.id),
            directory = InboxDirectoryState.Ready(File(context.filesDir, "inbox")),
            conversations = listOf(InboxConversation(peerId, listOf(entry("entry-1")))),
        )
    }

    /**
     * Compose the surface, then assert the configuration it was composed AT.
     *
     * The check lives here rather than in a `@Before` because before
     * `setContent` there is no rendering context to check — only the
     * instrumentation's own, which is a different object with a different
     * lifetime.
     */
    private fun host(state: InboxModel.State) {
        compose.setContent {
            rendering = LocalContext.current
            RelayiumTheme {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        // The page itself. `RelayiumTheme` sets colours but
                        // paints nothing; in the product the background comes
                        // from `RelayiumApp`'s `Scaffold`, whose default
                        // container colour is exactly this role. Without it
                        // this host keeps the test Activity's own light window
                        // background, so a dark capture showed correctly themed
                        // cards and text on white. Applied before the insets and
                        // the scroll, so it fills the window rather than the
                        // content.
                        .background(MaterialTheme.colorScheme.background)
                        // `MainActivity` draws edge to edge and the shell's
                        // `Scaffold` consumes the system bars for it. This host
                        // has no Scaffold, so without this the screen header
                        // renders under the status bar and every capture taken
                        // here shows an overlap the product does not have.
                        // Applied OUTSIDE the scroll, so the safe area is the
                        // viewport rather than something that scrolls away.
                        .windowInsetsPadding(WindowInsets.safeDrawing)
                        .verticalScroll(rememberScrollState())
                        .padding(Metrics.gutter),
                ) {
                    // The Scaffold's other half: it also provides the content
                    // colour for its background. Without it every Text that does
                    // not name a colour — the screen heading — drew in the
                    // default black, which a dark capture showed as black on
                    // near-black although the product has no such defect.
                    CompositionLocalProvider(
                        LocalContentColor provides MaterialTheme.colorScheme.onBackground,
                    ) {
                        // With a working Check now, so the status head captures
                        // the control a listening inbox actually offers.
                        InboxScreen(state, InboxActions(checkNow = {}))
                    }
                }
            }
        }
        compose.waitForIdle()
        assertRequestedConfiguration(
            requireNotNull(rendering) { "setContent never ran" }.resources.configuration,
            "the composition",
        )
    }

    // ── the structure itself ────────────────────────────────────────────────

    /**
     * A device row holds its own caveat.
     *
     * The reference's rule is that one row is one thing: the caveat that says a
     * send to this device needs approval belongs to THAT device and must not
     * float between rows, where it would read as applying to the next one.
     * Measured as containment, so it stays true in either language and at any
     * font scale.
     */
    @Test
    fun aGroupedRowKeepsItsOwnCaveatInsideItself() {
        host(populated())

        val row = compose.onNode(isSelectable() and hasText("MacBook"))
        row.performScrollTo().assertIsDisplayed()
        compose.waitForIdle()
        val rowBounds = row.getUnclippedBoundsInRoot()

        // The UNMERGED text node. `Modifier.selectable` merges its descendants,
        // so the merged tree answers the row itself for the caveat's text and
        // the containment below would compare the row with itself.
        val caveat = compose.onNode(
            hasText(context.getString(R.string.inbox_caveat_approval)),
            useUnmergedTree = true,
        )
        val caveatBounds = caveat.getUnclippedBoundsInRoot()
        assertTrue(
            "the caveat query returned the merged row, so containment would be " +
                "vacuous — row $rowBounds, caveat $caveatBounds",
            caveatBounds.height < rowBounds.height,
        )
        assertTrue(
            "the caveat must sit inside the row it belongs to — row $rowBounds, caveat $caveatBounds",
            caveatBounds.top >= rowBounds.top - TOLERANCE &&
                caveatBounds.bottom <= rowBounds.bottom + TOLERANCE,
        )
        // The neighbouring row must start after this one ends, or the two are
        // not separated groups at all.
        val neighbour = compose.onNode(isSelectable() and hasText("Pixel Tablet"))
            .getUnclippedBoundsInRoot()
        assertTrue(
            "the next device row must begin below this one — $rowBounds then $neighbour",
            neighbour.top >= rowBounds.bottom - TOLERANCE,
        )
        assertTrue(
            "a selectable row is a touch target — ${rowBounds.height}",
            rowBounds.height >= Metrics.touch - TOLERANCE,
        )

        capture("inbox-grouped-rows")
    }

    /**
     * Choosing a device opens its send group; choosing it again closes it.
     *
     * This is the app's real disclosure. It is not decoration: the group that
     * appears is where files and a message are actually sent from, so it must
     * follow the selection exactly and leave nothing composed behind it.
     */
    @Test
    fun choosingADeviceOpensItsSendGroupAndChoosingItAgainClosesIt() {
        host(populated())
        val sendTo = context.getString(R.string.inbox_send_to, "MacBook")
        val row = compose.onNode(isSelectable() and hasText("MacBook"))

        compose.onAllNodesWithTextCount(sendTo).let {
            assertEquals("nothing is selected yet, so no send group exists", 0, it)
        }

        row.performScrollTo().performClick()
        compose.waitForIdle()
        row.assertIsSelected()
        compose.onNodeWithText(sendTo).performScrollTo().assertIsDisplayed()
        capture("inbox-send-open")

        row.performScrollTo().performClick()
        compose.waitForIdle()
        assertEquals(
            "deselecting must remove the send group, not merely hide it",
            0,
            compose.onAllNodesWithTextCount(sendTo),
        )
    }

    /**
     * Opening a conversation replaces the list; Back restores it.
     *
     * Both directions, because the failure worth catching is a detail that
     * leaves the list composed underneath it — two histories on one surface,
     * with the same labels in both.
     */
    @Test
    fun openingAConversationReplacesTheListAndBackRestoresIt() {
        host(populated())
        val open = context.getString(R.string.inbox_history_open)
        val back = context.getString(R.string.inbox_detail_back)

        compose.onNode(hasText(open) and hasClickAction()).performScrollTo().performClick()
        compose.waitForIdle()
        assertEquals(
            "the list's Open control must be gone while the detail is showing",
            0,
            compose.onAllNodesWithTextCount(open),
        )
        compose.onNodeWithText(back).performScrollTo().assertIsDisplayed()
        capture("inbox-conversation-open")

        compose.onNode(hasText(back) and hasClickAction()).performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNode(hasText(open) and hasClickAction()).performScrollTo().assertIsDisplayed()
        assertEquals(
            "returning must remove the detail's own Back control",
            0,
            compose.onAllNodesWithTextCount(back),
        )
    }

    /**
     * Every control on a fully populated surface clears the touch floor.
     *
     * Run at whatever width and font scale the harness configured, so the same
     * class is the 320dp/font-2 check when it is asked to be one. `height` is a
     * ceiling as well as a floor, which is the shape of the regression: a
     * control that measures exactly 48dp at scale 1 and clips its label at
     * scale 2 passes a fixed-height layout and fails this.
     */
    @Test
    fun everyControlOnAPopulatedSurfaceClearsTheTouchFloor() {
        host(populated())
        // Open the send group too, so its controls are part of the sweep.
        compose.onNode(isSelectable() and hasText("MacBook")).performScrollTo().performClick()
        compose.waitForIdle()

        val density = context.resources.displayMetrics.density
        val floorPx = (Metrics.touch.value - TOLERANCE.value) * density
        val short = compose.onAllNodes(hasClickAction()).fetchSemanticsNodes()
            .filter { it.size.height > 0 }
            .filter { it.size.height < floorPx }
        assertTrue(
            "these controls are under the touch floor: " +
                short.joinToString { "${it.id}@${it.size.height}px" },
            short.isEmpty(),
        )
        capture("inbox-touch-floor")
    }

    private fun capture(tag: String) = captureOrFail(compose, context, tag)

    /** How many nodes carry this text right now, without asserting anything —
     *  the honest way to say "and none". */
    private fun SemanticsNodeInteractionsProvider.onAllNodesWithTextCount(text: String): Int =
        onAllNodes(hasText(text)).fetchSemanticsNodes().size
}

/**
 * The Account surface after a REAL sign-in.
 *
 * The groups this work introduced — identity, plan, devices — only exist once
 * the server has answered, so this drives the real form against this run's
 * disposable origin rather than posing a state object. The reading column is
 * measured here too, because the shell that owns it is `RelayiumApp` and only
 * `MainActivity` composes it.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class ReferenceAccountLayoutAcceptanceTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    /**
     * The resumed Activity — the only object here whose resources are the ones
     * being drawn. `targetContext` is the application context: a per-app locale
     * lives on the Activity's resource context, and the application copy fell
     * back to the device locale the moment the first test's Activity finished,
     * so the second test compared zh against `en-US` and would also have looked
     * up English strings against a Chinese screen.
     */
    private var activity: MainActivity? = null
    private val context: Context
        get() = activity ?: error("no Activity is resumed yet")

    private fun s(id: Int) = context.resources.getString(id)

    /** Launch, remember what is actually rendering, and only then assert the
     *  configuration the harness asked for. */
    private fun <R> onTheAppUnderTest(body: (TransferViewModel) -> R): R =
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity = it }
            assertRequestedConfiguration(
                requireNotNull(activity) { "the Activity never reached onActivity" }
                    .resources.configuration,
                "the resumed Activity",
            )
            val vm = InteropDriver.viewModel()
            assertEquals(
                "the app under test must be pointed at this run's disposable server",
                origin,
                vm.backendOrigin,
            )
            body(vm)
        }

    private val origin get() = InteropDriver.requireArg("relayium.origin")
    private val email get() = InteropDriver.requireArg("relayium.email")
    private val password get() = InteropDriver.requireArg("relayium.password")

    @Before
    fun startFromASignedOutDevice() {
        // The bearer lives in the keystore, which outlives an ActivityScenario;
        // cleared through the real store so the reset runs the product's path.
        // The configuration check is NOT here: before an Activity is resumed
        // there is no rendering context to check. See `onTheAppUnderTest`.
        runCatching {
            KeystoreTokenStore(InstrumentationRegistry.getInstrumentation().targetContext).clear()
        }
    }

    /**
     * Reach a destination, then confirm arriving at it.
     *
     * At a large font scale `DestinationBar` becomes a horizontally SCROLLING
     * row, and Account is the last of five: it starts off the right edge.
     * `performClick` dispatches at the node's centre in root coordinates and
     * does not require the node to be visible, so the tap fell outside the
     * window and did nothing — and the test carried on typing an address into
     * whatever field the Transfer screen had. A click that was made is not a
     * click that landed.
     *
     * The scroll is attempted rather than required: the wide `NavigationBar`
     * form has no scrollable ancestor and `performScrollTo` throws there, which
     * is not a failure — that form needs no scrolling. What is required is that
     * the tab is DISPLAYED before the tap and SELECTED after it.
     */
    private fun openTab(label: Int) {
        val tab = compose.onNode(hasText(s(label)) and isSelectable())
        tab.assertExists()
        runCatching { tab.performScrollTo() }
        tab.assertIsDisplayed()
        tab.performClick()
        compose.waitForIdle()
        tab.assertIsSelected()
    }

    private fun openAccountTab() {
        openTab(R.string.tab_account)
        // Arrived, and on the surface this class is about: the sign-in group's
        // caption exists only on Account. Without this a destination that did
        // not change is discovered later, as a stray address in another
        // screen's field.
        caption(s(R.string.account_signin_title)).assertExists()
    }

    /**
     * Fill the form by LABEL.
     *
     * Never by index into `onAllNodes(hasSetTextAction())`: that is what quietly
     * typed an account address into the Transfer screen's code-or-link field
     * when the destination had not changed. A field is identified by the label
     * it carries, so a wrong screen cannot absorb a credential.
     */
    private fun field(label: Int) =
        compose.onNode(hasSetTextAction() and hasText(s(label)))

    private fun signInThroughTheForm() {
        field(R.string.account_email_label).performScrollTo().performTextInput(email)
        field(R.string.account_password_label).performScrollTo().performTextInput(password)
        compose.onNode(hasText(s(R.string.account_signin_action)) and hasClickAction())
            .performScrollTo().performClick()
    }

    /**
     * Wait for a real device list, and say something USEFUL when it never comes.
     *
     * A bare timeout reports only that the predicate stayed false. What is
     * reported instead is this app's own classification of the state and the
     * shape of the tree — a kind, two counts, and how many controls are
     * composed. No address, no token, no server prose: [AccountFailure.Kind] and
     * the numeric status are the app's own labels, and nothing here reads a
     * device name.
     */
    private fun awaitDeviceList(vm: TransferViewModel) {
        try {
            InteropDriver.awaitTrue("the device list loaded", timeoutMs = 60_000) {
                (vm.account.devices.value as? DevicesState.Loaded)
                    ?.devices?.any { it.current } == true
            }
        } catch (t: Throwable) {
            throw AssertionError(
                "the device list never reached Loaded with this device's own row — " +
                    "devices=${describeDevices(vm.account.devices.value)}, " +
                    "account=${vm.account.state.value::class.simpleName}, " +
                    "controls=${compose.onAllNodes(hasClickAction()).fetchSemanticsNodes().size}, " +
                    "devicesCaption=" +
                    compose.onAllNodes(hasText(s(R.string.account_devices_title)))
                        .fetchSemanticsNodes().size,
                t,
            )
        }
    }

    /** Kind and counts only — never a device name. */
    private fun describeDevices(state: DevicesState): String = when (state) {
        is DevicesState.Idle -> "Idle"
        is DevicesState.Loading -> "Loading"
        is DevicesState.Failed ->
            "Failed(${state.failure.kind}, status ${state.failure.status})"
        is DevicesState.Loaded ->
            "Loaded(total ${state.devices.size}, current ${state.devices.count { it.current }})"
    }

    /**
     * The reading column, as one formula.
     *
     * A caption is a direct child of the shell's column and carries no padding
     * of its own, so its left edge IS the content's left edge. Comparing that to
     * `(window − min(window, reading)) ÷ 2 + gutter` checks the cap, the gutter
     * and the centring at once, and it is the same assertion on a 320dp phone
     * and on a tablet — on the phone the cap term drops out and it becomes the
     * gutter check.
     */
    private fun assertReadingColumn(captionText: String) {
        val window = compose.onRoot().getUnclippedBoundsInRoot().width
        val column = min(window.value, Metrics.reading.value).dp
        val expectedLeft = ((window.value - column.value) / 2f).dp + Metrics.gutter
        val caption = caption(captionText).getUnclippedBoundsInRoot()
        assertTrue(
            "the reading column must start at $expectedLeft in a ${window} window, " +
                "but the caption begins at ${caption.left}",
            abs(caption.left.value - expectedLeft.value) <= TOLERANCE.value,
        )
    }

    /**
     * A caption, selected by NOT being a control.
     *
     * `account_signin_title` and `account_signin_action` are the same word in
     * both maintained languages — "Sign in", "登录" — so a text-only query
     * matches the group's caption and the button under it and resolves to
     * neither. A caption is never clickable, which is the honest split.
     */
    private fun caption(text: String) = compose.onNode(hasText(text) and !hasClickAction())

    /**
     * A real account, its own figures, and the groups they are arranged into.
     */
    @Test
    fun theSignedInAccountRendersItsGroupsInsideTheReadingColumn() {
        onTheAppUnderTest { vm ->
            openAccountTab()
            signInThroughTheForm()
            InteropDriver.awaitTrue("the account loaded") {
                vm.account.state.value is AccountState.Ready
            }
            // Settle the composition FIRST. The devices fetch is started by
            // `DevicesCard`'s own `LaunchedEffect`, and that effect does not run
            // until the tree that contains it has been composed — so waiting on
            // its result before letting composition proceed waits for work
            // nothing has asked for yet.
            compose.waitForIdle()
            // A capture taken on `Ready` alone is a picture of a spinner, so the
            // real list is required, including the row the server bound this
            // bearer to.
            awaitDeviceList(vm)
            compose.waitForIdle()

            // The identity, plan and devices captions are the three groups this
            // surface was regrouped into; all three are present at once.
            for (caption in listOf(
                R.string.account_identity_title,
                R.string.account_plan_title,
                R.string.account_devices_title,
            )) {
                compose.onNodeWithText(s(caption)).performScrollTo().assertIsDisplayed()
            }

            // A caption sits ABOVE the group it names, which is the hierarchy
            // change itself. Both frames are read AFTER the last scroll and
            // without scrolling between them: bounds are reported in root
            // coordinates, so two reads at different scroll offsets would
            // compare positions that never existed at the same time.
            compose.onNodeWithText(s(R.string.account_identity_title)).performScrollTo()
            compose.waitForIdle()
            val identity = compose.onNodeWithText(s(R.string.account_identity_title))
                .getUnclippedBoundsInRoot()
            val address = compose.onNodeWithText(email, substring = true)
                .getUnclippedBoundsInRoot()
            assertTrue(
                "the caption must sit above the group — caption $identity, address $address",
                address.top >= identity.bottom - TOLERANCE,
            )
            assertReadingColumn(s(R.string.account_identity_title))
            captureOrFail(compose, context, "account-signed-in")
            // Measured while the list is known-loaded, so the report below does
            // not depend on what a later remount happens to be doing.
            val deviceCount = (vm.account.devices.value as DevicesState.Loaded).devices.size

            // Every destination, in the shell that owns the reading column, so
            // the captures cover the surfaces the shared caption change also
            // touched rather than Account alone. No new seam: these are the
            // app's own five tabs, clicked.
            for ((tab, tag) in listOf(
                R.string.tab_transfer to "transfer",
                R.string.tab_nearby to "nearby",
                R.string.tab_inbox to "inbox",
                R.string.tab_cloud to "cloud",
                R.string.tab_account to "account",
            )) {
                openTab(tab)
                // Coming back to Account REMOUNTS `DevicesCard`, and its
                // `LaunchedEffect(Unit)` starts a fresh request. Compose
                // idleness is not network idleness, so without waiting for the
                // list again this capture is a picture of a spinner.
                if (tab == R.string.tab_account) {
                    awaitDeviceList(vm)
                    compose.waitForIdle()
                }
                captureOrFail(compose, context, "tab-$tag")
            }

            InteropDriver.report(
                "reference-account",
                mapOf(
                    "phase" to "signed-in",
                    "email" to (vm.account.state.value as AccountState.Ready).user.email,
                    "deviceCount" to deviceCount,
                    // Whole dp as an Int: `InteropDriver.encode` emits only
                    // Boolean/Int/Long unquoted, so a Float would reach the
                    // runner as a string.
                    "windowDp" to compose.onRoot().getUnclippedBoundsInRoot().width.value
                        .roundToInt(),
                ),
            )
        }
    }

    /** Signing out returns the form, in the same column, with no group left
     *  behind from the session that ended. */
    @Test
    fun signingOutReturnsTheFormInsideTheSameReadingColumn() {
        onTheAppUnderTest { vm ->
            openAccountTab()
            signInThroughTheForm()
            InteropDriver.awaitTrue("the account loaded") {
                vm.account.state.value is AccountState.Ready
            }
            compose.waitForIdle()

            compose.onNode(hasText(s(R.string.account_sign_out)) and hasClickAction())
                .performScrollTo().performClick()
            InteropDriver.awaitTrue("the session ended") {
                vm.account.state.value is AccountState.SignedOut ||
                    vm.account.state.value is AccountState.Rejected
            }
            compose.waitForIdle()

            assertEquals(
                "the plan group must not outlive the session it described",
                0,
                compose.onAllNodes(hasText(s(R.string.account_plan_title)))
                    .fetchSemanticsNodes().size,
            )
            val form = s(R.string.account_signin_title)
            caption(form).performScrollTo().assertIsDisplayed()
            assertReadingColumn(form)
            captureOrFail(compose, context, "account-signed-out")
        }
    }
}

// ── shared harness ──────────────────────────────────────────────────────────

/** Layout is measured in whole dp; a rounding step is not a defect. */
private val TOLERANCE: Dp = 2.dp

/**
 * The device is actually rendering at the configuration the harness asked for.
 *
 * `wm density`, `settings put system font_scale`, `cmd uimode night` and a
 * per-app locale can each be ACCEPTED and not applied. A matrix that asserted
 * only what it requested would report narrow, large-font, dark, Chinese
 * coverage it never had. Every argument is optional, so the class still runs
 * from an IDE with none of them.
 *
 * Takes the configuration of the thing that ACTUALLY RENDERS — a resumed
 * Activity, or the composition itself — never the instrumentation's
 * `targetContext`. A per-app locale is attached to the Activity's resource
 * context; the application context holds a separate, process-cached `Resources`
 * whose configuration is re-resolved on system callbacks, and it fell back to
 * the device locale as soon as the first test's Activity finished. Reading it
 * meant asserting one context and rendering another.
 */
private fun assertRequestedConfiguration(configuration: Configuration, where: String) {
    val args = InstrumentationRegistry.getArguments()

    args.getString("relayium.smallestWidthDp")?.takeIf { it.isNotBlank() }?.let { requested ->
        assertTrue(
            "requested $requested dp smallest width, $where reports " +
                "${configuration.smallestScreenWidthDp}",
            configuration.smallestScreenWidthDp <= requested.toInt(),
        )
    }
    args.getString("relayium.fontScale")?.takeIf { it.isNotBlank() }?.let { requested ->
        assertEquals(
            "requested font scale $requested, $where reports ${configuration.fontScale}",
            requested.toFloat(),
            configuration.fontScale,
            0.01f,
        )
    }
    args.getString("relayium.night")?.takeIf { it == "yes" || it == "no" }?.let { requested ->
        val night = configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
            Configuration.UI_MODE_NIGHT_YES
        assertEquals(
            "requested night=$requested, $where uiMode=${configuration.uiMode}",
            requested == "yes",
            night,
        )
    }
    args.getString("relayium.language")?.takeIf { it.isNotBlank() }?.let { requested ->
        assertEquals(
            "requested language $requested, $where resolves " +
                "${configuration.locales.toLanguageTags()}",
            requested,
            configuration.locales[0].language,
        )
    }
}

/**
 * A capture that FAILS when it did not happen.
 *
 * `UiDevice.takeScreenshot` answers false on a denied or failed grab and an
 * earlier run's file would still be on disk, so the old file is removed first
 * and the new one is required to exist and to be non-empty. A capture suite
 * that swallowed this would report coverage of pictures nobody took.
 *
 * Written into the app's OWN files dir: this app holds no storage permission,
 * so a write to shared storage is denied, and a path the process cannot write
 * is a screenshot promised and never made. The runner pulls them with `run-as`.
 */
private fun captureOrFail(compose: ComposeTestRule, context: Context, tag: String) {
    compose.waitForIdle()
    val configuration = context.resources.configuration
    val name = buildString {
        append("reference-")
        append(tag)
        append('-')
        append(configuration.locales[0].language)
        append("-font")
        append(configuration.fontScale)
        append('-')
        append(
            if (configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
                Configuration.UI_MODE_NIGHT_YES
            ) {
                "night"
            } else {
                "day"
            },
        )
        append('-')
        append(configuration.smallestScreenWidthDp)
        append("dp.png")
    }
    val file = File(context.filesDir, name)
    file.delete()
    val taken = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        .takeScreenshot(file)
    assertTrue("the screenshot for $tag was refused by the device", taken)
    assertTrue("no screenshot was written for $tag at ${file.absolutePath}", file.isFile)
    assertTrue("the screenshot for $tag is empty at ${file.absolutePath}", file.length() > 0L)
}
