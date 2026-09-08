@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.relayium.android.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MailOutline
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.activity.compose.LocalActivity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.relayium.android.BuildConfig
import com.relayium.android.R
import com.relayium.android.TransferController
import com.relayium.android.TransferViewModel
import com.relayium.android.account.AccountState
import com.relayium.android.account.CreateLinkModel
import com.relayium.android.account.PairCodeExpiry
import com.relayium.android.inbox.InboxConversationEntry
import com.relayium.android.inbox.InboxSendTarget
import com.relayium.android.ingress.IngressRefusal
import com.relayium.android.ingress.IngressSurface
import com.relayium.android.ingress.ShareItemRefusal
import com.relayium.android.integration.IngressHost
import com.relayium.android.integration.PickerLease
import com.relayium.android.scan.ScannerSheet
import com.relayium.android.update.UpdateChecker
import com.relayium.protocol.JoinInput
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The things this build can do, and nothing it cannot. There is no destination
 * here for a feature that is not implemented: one that opens onto a placeholder
 * is a claim the product does not honour.
 *
 * The order is the order they are shown in, and it is the order of how often
 * they are used rather than the order they were built in.
 */
internal enum class Destination { TRANSFER, NEARBY, INBOX, CLOUD, ACCOUNT }

/**
 * The shell: a destination bar, and one of two surfaces under it. The layout
 * constants follow the app-wide rhythm — 16dp card padding, 20dp between
 * sections, a readable max width on tablets, every tappable target at least
 * 48dp.
 *
 * ## Why the system pickers are launched from HERE
 *
 * `rememberLauncherForActivityResult` registers its result callback for as long
 * as the composable that called it stays in the composition, and unregisters it
 * when that composable leaves. Registering the file and folder pickers inside
 * the transfer surface would therefore tie them to the SELECTED TAB: a user who
 * opened the document picker and — while the system UI was in front — had the
 * app recreated onto the account tab would come back to a result with nobody
 * left to receive it, which reads as a chosen file that silently never sends.
 * Hoisting them above the destination switch means the registration outlives
 * every tab change, and the two link fences the results carry (see
 * [TransferViewModel.sendPicked] and the controller's own `promptId`) are
 * unchanged.
 */
@Composable
fun RelayiumApp(viewModel: TransferViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val joinError by viewModel.joinError.collectAsStateWithLifecycle()
    val pickError by viewModel.pickError.collectAsStateWithLifecycle()

    var destination by rememberSaveable { mutableStateOf(Destination.TRANSFER) }

    // The controller-owned link identity each picker result must be handed back
    // with, captured AT LAUNCH and saved across the picker round trip. The
    // CONTROLLER compares it on its session executor before any lane mutation,
    // so a file chosen for one connection can never be sent on the next.
    var sendLinkId by rememberSaveable { mutableIntStateOf(0) }
    var saveLinkId by rememberSaveable { mutableIntStateOf(0) }
    var savePromptId by rememberSaveable { mutableIntStateOf(0) }

    /**
     * The bounded lease token each owned picker round trip runs under.
     *
     * The composition holds the TOKEN; [TransferViewModel.pickerLease] holds the
     * deadline. That split is the mechanism rather than a detail: the ViewModel
     * survives the recreation that happens behind a picker, so nothing on the
     * recreation path can restart the two-minute clock. What is written into
     * saved instance state is an opaque `<runtime>:<counter>` string carrying no
     * URI, grant, code or name — and one minted by a previous process cannot
     * alias a token this one issued.
     *
     * One per launcher, because two round trips can overlap and each must be
     * able to expire on its own deadline.
     */
    var sendLease by rememberSaveable { mutableStateOf("") }
    var saveLease by rememberSaveable { mutableStateOf("") }
    var cloudFileLease by rememberSaveable { mutableStateOf("") }
    var cloudFolderLease by rememberSaveable { mutableStateOf("") }

    val filePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        // A PRESENCE round trip: this device went on advertising itself while
        // the picker was in front. An expired lease has already withdrawn that
        // claim and retired the operation, so its answer may not revive the
        // session it was chosen for.
        if (viewModel.pickerReturned(sendLease) == PickerLease.Verdict.LIVE) {
            viewModel.sendPicked(uris, sendLinkId)
        }
    }

    val folderPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocumentTree(),
    ) { tree ->
        if (viewModel.pickerReturned(saveLease) == PickerLease.Verdict.LIVE) {
            viewModel.acceptIncoming(savePromptId, tree, saveLinkId)
        }
    }

    // The cloud surface's own pair. Separate launchers rather than shared ones
    // because their results mean different things — a cloud file choice starts
    // an upload, a link file choice stages a send on a live session — and one
    // launcher would have to carry a mode through the system round trip to tell
    // them apart. Registered HERE for the same reason as the two above: the
    // registration must outlive a tab change and an Activity recreation.
    // The request this pick is happening under, saved across the system round
    // trip exactly as the session pickers' link tokens are. A plain counter,
    // and nothing secret.
    var cloudPickId by rememberSaveable { mutableIntStateOf(0) }

    /** The transfer a folder choice is being made for; rechecked at the save. */
    var cloudTransferId by rememberSaveable { mutableIntStateOf(0) }

    val cloudFilePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        // A DATA round trip: nothing was claimed to anybody else while it was
        // away, so a lease that merely EXPIRED must not discard the user's pick
        // — the upload model's own request fence decides whether the choice is
        // still the one it asked for, and overruling it here would be a second,
        // blunter fence.
        //
        // UNKNOWN is a different answer and must be refused BEFORE any provider
        // read: the token was not issued by this lease, so it belongs to a
        // previous process, to a launch this one replaced, or to a result
        // already consumed. There is no operation for it to be about.
        if (viewModel.pickerReturned(cloudFileLease) == PickerLease.Verdict.UNKNOWN) {
            return@rememberLauncherForActivityResult
        }
        viewModel.cloudFilesPicked(uris, cloudPickId)
    }

    val cloudFolderPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocumentTree(),
    ) { tree ->
        if (viewModel.pickerReturned(cloudFolderLease) == PickerLease.Verdict.UNKNOWN) {
            return@rememberLauncherForActivityResult
        }
        viewModel.cloudFolderPicked(tree, cloudTransferId)
    }

    val cloudPickers = CloudPickers(
        chooseFiles = {
            cloudPickId = viewModel.cloudUpload.beginSelection()
            cloudFileLease = viewModel.pickerLaunched(PickerLease.Claim.DATA, replacing = cloudFileLease)
            cloudFilePicker.launch(arrayOf("*/*"))
        },
        chooseFolder = {
            cloudTransferId = viewModel.cloudDownload.currentTransfer()
            cloudFolderLease = viewModel.pickerLaunched(PickerLease.Claim.DATA, replacing = cloudFolderLease)
            cloudFolderPicker.launch(null)
        },
    )

    // The Inbox surface's launchers, registered HERE for exactly the reason the
    // others are — and this was got wrong once. Registering them inside the
    // Inbox destination tied their result callbacks to the SELECTED TAB: a user
    // who chose files to send and, while `DocumentsUI` was in front, had the app
    // recreated onto another destination would come back to a result with
    // nobody left to receive it. That reads as a chosen file that silently never
    // sends, which is the failure the stable-above-navigation rule exists to
    // prevent.
    var inboxTargetId by rememberSaveable { mutableStateOf("") }
    var inboxSendLease by rememberSaveable { mutableStateOf("") }
    var inboxExportEntryId by rememberSaveable { mutableStateOf("") }
    var inboxExportLease by rememberSaveable { mutableStateOf("") }

    /** The account generation each round trip was launched under. A counter,
     *  and nothing that names anybody — which is what may go into saved state. */
    var inboxSendAccount by rememberSaveable { mutableIntStateOf(-1) }
    var inboxExportAccount by rememberSaveable { mutableIntStateOf(-1) }

    /** What the last open, export or share did. Transient, never persisted. */
    var inboxNotice by remember { mutableStateOf<Int?>(null) }
    val scope = rememberCoroutineScope()

    val inboxSendPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        // A DATA round trip: nothing was claimed to another device while the
        // picker was in front, so a lease that merely EXPIRED must not discard
        // the user's choice — the account fence below is what decides whether
        // it may still be delivered. UNKNOWN is different: the token was never
        // issued by this lease, which is a result from a previous process or
        // one already consumed, and there is no operation for it to belong to.
        if (viewModel.pickerReturned(inboxSendLease) == PickerLease.Verdict.UNKNOWN) {
            return@rememberLauncherForActivityResult
        }
        if (inboxTargetId.isNotEmpty()) {
            viewModel.inboxSendPicked(uris, inboxTargetId, inboxSendAccount)
        }
    }

    val inboxExportPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocumentTree(),
    ) { tree ->
        if (viewModel.pickerReturned(inboxExportLease) == PickerLease.Verdict.UNKNOWN) {
            return@rememberLauncherForActivityResult
        }
        val entryId = inboxExportEntryId
        if (entryId.isNotEmpty()) {
            scope.launch {
                inboxNotice = when (viewModel.inboxExport(entryId, tree, inboxExportAccount)) {
                    TransferViewModel.ExportOutcome.DONE -> R.string.inbox_export_done
                    TransferViewModel.ExportOutcome.UNAVAILABLE -> R.string.inbox_export_unavailable
                    TransferViewModel.ExportOutcome.FAILED -> R.string.inbox_export_failed
                    TransferViewModel.ExportOutcome.FAILED_INCOMPLETE ->
                        R.string.inbox_export_incomplete
                }
            }
        }
    }

    val inboxPickers = InboxPickers(
        chooseFiles = { target ->
            inboxTargetId = target.deviceId
            // Captured AT LAUNCH, with the target: the pair is what the result
            // is checked against, so neither can drift across the round trip.
            inboxSendAccount = viewModel.accountGeneration()
            inboxSendLease = viewModel.pickerLaunched(PickerLease.Claim.DATA, replacing = inboxSendLease)
            inboxSendPicker.launch(arrayOf("*/*"))
        },
        chooseFolder = { entryId ->
            inboxExportEntryId = entryId
            inboxExportAccount = viewModel.accountGeneration()
            inboxExportLease = viewModel.pickerLaunched(PickerLease.Claim.DATA, replacing = inboxExportLease)
            inboxExportPicker.launch(null)
        },
    )

    val pickers = Pickers(
        chooseFiles = { linkId ->
            sendLinkId = linkId
            sendLease = viewModel.pickerLaunched(PickerLease.Claim.PRESENCE, replacing = sendLease)
            filePicker.launch(arrayOf("*/*"))
        },
        chooseFolder = { linkId, promptId ->
            saveLinkId = linkId
            savePromptId = promptId
            saveLease = viewModel.pickerLaunched(PickerLease.Claim.PRESENCE, replacing = saveLease)
            folderPicker.launch(null)
        },
    )

    // The presence claims are NOT computed here any more.
    //
    // `isChangingConfigurations` is the Activity's own answer and the picker
    // lease lives in the ViewModel, so both inputs to "is this app in front of
    // the user" are outside the composition — and a claim made to another
    // device must not depend on whether a particular composable happened to be
    // in the tree. `MainActivity.onStart`/`onStop` report the two facts and
    // `HostPresence` decides. See [TransferViewModel.hostStopped].

    // What another app has handed this one, and where the shell was asked to go.
    val staged by viewModel.ingress.staged.collectAsStateWithLifecycle()
    val ingressRefusal by viewModel.ingress.refusal.collectAsStateWithLifecycle()
    val navigation by viewModel.ingress.navigation.collectAsStateWithLifecycle()

    /**
     * Whether the share surface is the one being shown.
     *
     * Saved, so a rotation while choosing a destination does not drop the user
     * back onto the transfer tab. It is a boolean and nothing more: the share
     * ITSELF lives in the ViewModel, because a staged URI is a grant and shared
     * text is the user's message, and neither belongs in saved instance state.
     */
    var showShare by rememberSaveable { mutableStateOf(false) }

    // One shot. The coordinator navigates once, when the request arrives, and
    // never again — so a recreation cannot yank the screen away from wherever
    // the user has since gone. Consuming it here is what makes that true.
    LaunchedEffect(navigation) {
        when (navigation) {
            IngressSurface.JOIN -> {
                destination = Destination.TRANSFER
                showShare = false
            }
            IngressSurface.STORED -> {
                destination = Destination.CLOUD
                showShare = false
            }
            IngressSurface.SHARE -> showShare = true
            null -> return@LaunchedEffect
        }
        viewModel.ingress.consumeNavigation()
    }

    // A share that has been dispatched or cancelled has no surface to be on.
    LaunchedEffect(staged) {
        if (staged == null) showShare = false
    }

    // Back leaves the share surface without discarding what is staged — the
    // banner below is how it is reached again — and otherwise returns to the
    // transfer surface rather than leaving the app. Off the transfer tab only,
    // so the system's own "back closes the app" is untouched where it is right.
    BackHandler(enabled = showShare || destination != Destination.TRANSFER) {
        if (showShare) showShare = false else destination = Destination.TRANSFER
    }

    Scaffold(
        bottomBar = { DestinationBar(destination) { destination = it; showShare = false } },
    ) { insets ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(insets)
                .imePadding(),
            contentAlignment = Alignment.TopCenter,
        ) {
            Column(
                modifier = Modifier
                    .widthIn(max = 520.dp)
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                // Session-level, above everything and on BOTH surfaces:
                // leftovers are real whatever the user is looking at, and the
                // warning stays until dismissed.
                if (state.cleanupIncomplete) {
                    CleanupWarningCard(onDismiss = viewModel::dismissCleanupWarning)
                }
                // Why something handed to this app was refused. Above the
                // surfaces for the same reason: it is true wherever the user is.
                ingressRefusal?.let { reason ->
                    StatusCard(text = stringResource(ingressRefusalText(reason)), isError = true)
                    TextButton(onClick = viewModel.ingress::clearRefusal) {
                        Text(stringResource(R.string.ingress_dismiss))
                    }
                }
                val held = staged
                if (held != null && !showShare) {
                    // Something is waiting and the user has navigated away from
                    // it. Without this the share would be unreachable — held,
                    // with no way back to it — which is worse than not having
                    // accepted it.
                    StagedShareBanner(held) { showShare = true }
                }
                if (showShare && held != null) {
                    ShareSurface(
                        staged = held,
                        state = state,
                        viewModel = viewModel,
                        onDismiss = { showShare = false },
                        onOpenAccount = { destination = Destination.ACCOUNT; showShare = false },
                    )
                } else {
                    when (destination) {
                    // A session belongs to the destination it was STARTED from.
                    // Without that, a Nearby transfer would also paint the
                    // cross-network tab — the two share one controller, and its
                    // phase alone cannot say which door the user came through.
                    Destination.TRANSFER -> if (state.nearby.active) {
                        // NOT the join form. Joining or minting a code replaces
                        // whatever this controller is doing, and a Nearby
                        // session — possibly a running transfer — is what it is
                        // doing. Offering the form here would destroy that from
                        // a button that says nothing about it, so the switch is
                        // made explicit instead.
                        SwitchAwayCard(
                            explanation = stringResource(R.string.transfer_nearby_running),
                            action = stringResource(R.string.transfer_stop_nearby),
                            onSwitch = viewModel::endSessionForSwitch,
                        )
                    } else {
                        when (state.phase) {
                            TransferController.Phase.IDLE ->
                                JoinScreen(state, joinError, endedBanner = false, viewModel) {
                                    destination = Destination.ACCOUNT
                                }
                            TransferController.Phase.ENDED ->
                                JoinScreen(state, joinError, endedBanner = true, viewModel) {
                                    destination = Destination.ACCOUNT
                                }
                            TransferController.Phase.CONNECTING,
                            TransferController.Phase.WAITING_PEER,
                            -> ConnectingScreen(state, viewModel)
                            TransferController.Phase.CONNECTED ->
                                SessionScreen(state, pickError, viewModel, pickers)
                        }
                    }
                    Destination.NEARBY ->
                        if (state.nearby.active &&
                            state.phase == TransferController.Phase.CONNECTED
                        ) {
                            // The SAME session surface a pairing code reaches.
                            // A Nearby transfer is not a different product once
                            // it is connected, and a second copy of that screen
                            // is a second place for its rules to drift.
                            SessionScreen(state, pickError, viewModel, pickers)
                        } else {
                            NearbyScreen(state, viewModel)
                        }
                    Destination.INBOX -> InboxDestination(
                        viewModel = viewModel,
                        pickers = inboxPickers,
                        notice = inboxNotice,
                        onNotice = { inboxNotice = it },
                        onOpenAccount = { destination = Destination.ACCOUNT },
                    )
                    Destination.CLOUD -> CloudScreen(viewModel, cloudPickers) {
                        destination = Destination.ACCOUNT
                    }
                    Destination.ACCOUNT -> AccountScreen(viewModel)
                    }
                }
            }
        }
    }
}

/**
 * One surface saying what the OTHER one is doing, and offering the one button
 * that would free it.
 *
 * There is a single [TransferController] and it owns one connection, so the two
 * transfer surfaces genuinely cannot both be live. The choice is between doing
 * the replacement silently and saying so; this says so, and the destruction
 * happens on a press whose label names it.
 */
@Composable
internal fun SwitchAwayCard(explanation: String, action: String, onSwitch: () -> Unit) {
    StatusCard(text = explanation, isError = false)
    OutlinedButton(
        onClick = onSwitch,
        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
    ) {
        Text(action)
    }
}

/**
 * The destination bar, in the form the current screen can actually render.
 *
 * ## Why it adapts
 *
 * A [NavigationBar] divides its width evenly and gives each item one line for
 * its label. At four destinations on a 320dp screen that is 80dp each, and at
 * font scale 2 a word like "Transfer" needs closer to 110 — so the labels
 * ellipsize, and the user is choosing between truncated words. Adding the fifth
 * destination this shell is heading for makes it worse.
 *
 * So when the row cannot hold full labels, it becomes a horizontally SCROLLING
 * row that gives each destination as much width as its label needs. Nothing is
 * abbreviated and nothing is hidden behind a menu.
 *
 * A drawer was the other candidate and is deliberately not this. It would put
 * every destination behind an extra tap and behind a control the user has to
 * discover, and it would make each destination reachable only after opening it —
 * which is a real accessibility regression for screen-reader traversal, not only
 * a preference. Scrolling keeps every destination a first-class, directly
 * addressable, fully labelled target in EVERY configuration.
 *
 * Both forms carry `Role.Tab` selection semantics, so what a screen reader — and
 * an instrumentation test — sees does not change with the screen size.
 */
@Composable
private fun DestinationBar(current: Destination, onSelect: (Destination) -> Unit) {
    val entries = listOf(
        Triple(Destination.TRANSFER, Icons.Filled.Send, R.string.tab_transfer),
        Triple(Destination.NEARBY, Icons.Filled.Search, R.string.tab_nearby),
        Triple(Destination.INBOX, Icons.Filled.MailOutline, R.string.tab_inbox),
        Triple(Destination.CLOUD, Icons.Filled.Share, R.string.tab_cloud),
        Triple(Destination.ACCOUNT, Icons.Filled.Person, R.string.tab_account),
    )
    val density = LocalDensity.current
    // The WINDOW's width, not the screen's: `Configuration.screenWidthDp` rounds
    // to whole dp and applies insets differently across target versions, and
    // this bar is laid out in the window it is actually in — which on a split
    // screen or a freeform window is not the display.
    val widthDp = with(density) { LocalWindowInfo.current.containerSize.width.toDp() }
    // Derived from what actually breaks — the width one label gets — rather than
    // from a device class, so adding a destination moves the threshold by itself.
    val roomPerLabel = widthDp / entries.size
    val compact = roomPerLabel < MIN_LABEL_DP || density.fontScale > MAX_EVEN_FONT_SCALE

    if (!compact) {
        NavigationBar {
            for ((target, icon, label) in entries) {
                NavigationBarItem(
                    selected = current == target,
                    onClick = { onSelect(target) },
                    icon = { Icon(icon, contentDescription = null) },
                    label = { Text(stringResource(label)) },
                )
            }
        }
        return
    }

    Surface(tonalElevation = 3.dp) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 8.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            for ((target, icon, label) in entries) {
                val selected = current == target
                Column(
                    modifier = Modifier
                        .selectable(
                            selected = selected,
                            onClick = { onSelect(target) },
                            role = Role.Tab,
                        )
                        .defaultMinSize(minWidth = 72.dp, minHeight = 56.dp)
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(
                        icon,
                        contentDescription = null,
                        tint = if (selected) {
                            MaterialTheme.colorScheme.onSecondaryContainer
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                    // softWrap off and NO width bound: the row scrolls instead
                    // of the word breaking, which is the whole point of this
                    // form. A label is never shortened.
                    Text(
                        text = stringResource(label),
                        style = MaterialTheme.typography.labelLarge,
                        softWrap = false,
                        color = if (selected) {
                            MaterialTheme.colorScheme.onSecondaryContainer
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                }
            }
        }
    }
}

/**
 * Below this much width per destination, an even split starts truncating.
 *
 * ## Why 72 and not 88
 *
 * The former value was derived while there were four destinations, and it mixed
 * two questions: how much room a label needs at the DEFAULT font scale, and how
 * much it needs at a large one. The second question is answered separately by
 * [MAX_EVEN_FONT_SCALE], so this one only has to be the first.
 *
 * At five destinations the difference is not cosmetic. 88dp each needs 440dp,
 * which is wider than almost every phone — so an 88 here would put ORDINARY
 * devices at the default font size into the scrolling form, where the fifth
 * destination starts off screen and has to be discovered by swiping a bar most
 * people will not think to swipe. Making the Inbox and Account destinations
 * reachable only by a gesture is a real discoverability regression, not a
 * layout preference.
 *
 * 72dp is what a Material navigation item actually needs for these five labels
 * at font scale 1.0, and 5 × 72 = 360dp, which ordinary phones exceed. So the
 * common case is the standard bar with all five visible and labelled, and the
 * scrolling form stays what it was designed to be: the fallback for a genuinely
 * narrow screen (320dp) or a large font, where nothing could have fitted and
 * scrolling beats truncating.
 */
private val MIN_LABEL_DP = 72.dp

/** Above this, even a wide screen's even split cannot hold a full label. */
private const val MAX_EVEN_FONT_SCALE = 1.3f

/**
 * The two system pickers, as callbacks the session surface invokes.
 *
 * A holder rather than two parameters because both carry the SAME contract: the
 * caller passes the link (and, for a folder, the prompt) the launch is happening
 * under, and nothing downstream re-derives it. See [RelayiumApp] for why the
 * launchers themselves live above the destination switch.
 */
internal class Pickers(
    val chooseFiles: (linkId: Int) -> Unit,
    val chooseFolder: (linkId: Int, promptId: Int) -> Unit,
)

// ── join ────────────────────────────────────────────────────────────────────

@Composable
private fun JoinScreen(
    state: TransferController.State,
    joinError: JoinInput.Result.Reason?,
    endedBanner: Boolean,
    viewModel: TransferViewModel,
    onOpenAccount: () -> Unit,
) {
    // Owned by the ViewModel rather than by this composable, because a SCANNED
    // code and a TAPPED LINK both prefill it — and a value a composable owned
    // could not be written from outside the composition. In memory only: the
    // ViewModel already survives rotation and the picker round trip, which is
    // the lifetime the field needs, and process death honestly ends it.
    val input by viewModel.joinDraft.collectAsStateWithLifecycle()

    /** Whether the camera sheet is open. A boolean, and nothing else, is what
     *  goes into saved state — never a payload. */
    var scanning by rememberSaveable { mutableStateOf(false) }

    // Submitting hides the keyboard FIRST: at large font scales on a narrow
    // screen the field's supporting-text error can sit entirely below the IME,
    // and a Done that validates invisibly reads as a dead key. (Observed on
    // the 320dp/font-2 emulator pass; the join code itself is not sensitive
    // keyboard state.)
    val keyboard = LocalSoftwareKeyboardController.current
    val submit = {
        keyboard?.hide()
        viewModel.joinFromDraft()
    }

    Text(
        text = stringResource(R.string.join_title),
        style = MaterialTheme.typography.headlineSmall,
    )

    if (endedBanner) {
        StatusCard(
            text = state.errorKey?.let { stringResource(errorText(it)) }
                ?: stringResource(R.string.session_ended),
            isError = state.errorKey != null,
        )
    }

    Text(
        text = stringResource(R.string.join_intro),
        style = MaterialTheme.typography.bodyLarge,
    )

    CreateCard(viewModel, onOpenAccount)

    HorizontalDivider()

    Text(
        text = stringResource(R.string.join_section_title),
        style = MaterialTheme.typography.titleMedium,
    )

    OutlinedTextField(
        value = input,
        onValueChange = { viewModel.updateJoinDraft(it) },
        modifier = Modifier.fillMaxWidth(),
        label = { Text(stringResource(R.string.join_field_label)) },
        placeholder = { Text(stringResource(R.string.join_field_hint), style = MonospaceDigits) },
        textStyle = if (input.length <= JoinInput.CODE_LENGTH && input.all { it.isDigit() }) {
            MonospaceDigits
        } else {
            MaterialTheme.typography.bodyLarge
        },
        isError = joinError != null,
        supportingText = joinError?.let { { Text(stringResource(joinErrorText(it))) } },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
        keyboardActions = KeyboardActions(onDone = { submit() }),
    )

    Button(
        onClick = { submit() },
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp),
    ) {
        Text(
            if (endedBanner) stringResource(R.string.status_reconnect)
            else stringResource(R.string.join_action),
        )
    }

    // The camera is the SHORTCUT, and the field above is the full path. This
    // button is the only thing that ever asks for the camera permission: asking
    // at launch would be a prompt for a feature nobody has touched, and it
    // teaches people to deny the one that matters later.
    OutlinedButton(
        onClick = { scanning = true },
        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
    ) {
        Text(stringResource(R.string.scan_open))
    }

    if (scanning) {
        // In a SHEET, which is a window of its own with a bounded height — not
        // inline in this column.
        //
        // The join surface is inside the shell's outer `verticalScroll`, and a
        // scrollable parent measures its children with an INFINITE maximum
        // height. `ScannerSheet` is itself vertically scrollable (deliberately:
        // at 320dp and font 2 its Cancel button would otherwise be laid out past
        // the bottom edge), and a scrollable measured under an infinite height
        // constraint throws — which is exactly what it did here, crashing the
        // app the moment the scan button was pressed.
        //
        // Fixed at the HOST rather than in the accepted scanner: the component
        // is right to scroll, and what was wrong is the container this shell put
        // it in. A modal sheet is also the placement its name and its dismissal
        // contract already assumed.
        // A swipe or a scrim tap is the user finishing with the scanner just as
        // Cancel is, so it closes an outstanding permission question too.
        // FULLY EXPANDED, never at the half-height a modal sheet defaults to.
        //
        // `ModalBottomSheet` opens partially expanded unless told otherwise, and
        // a device screenshot showed exactly what that costs here: the bounded
        // viewfinder — legitimately up to 320dp — fills the visible half, and
        // the hint, the manual-entry line and CANCEL are clipped below the
        // screen. The sheet's own content already scrolls, but the control that
        // releases the camera being off screen by default is not something a
        // scroll gesture should be required to discover.
        //
        // The viewfinder is not the problem and is left alone: it is already
        // bounded low, deliberately, so that the way out fits beside it. What
        // was wrong is the height it was being bounded INSIDE.
        ModalBottomSheet(
            onDismissRequest = {
                viewModel.scanner.dismiss()
                scanning = false
            },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        ) {
            // A decoded code only PREFILLS the field above — the scanner's
            // callback crosses the same ingress coordinator a tapped link does,
            // whose vocabulary has no case that could connect. There is no
            // auto-join and no session takeover.
            ScannerSheet(
                controller = viewModel.scanner,
                onDismiss = { scanning = false },
            )
        }
    }

    Text(
        text = stringResource(R.string.join_helper),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    // The update row lives HERE and only here. Being drawn by JoinScreen — the
    // IDLE and ENDED phases — is what makes "a check can never interrupt a
    // transfer" structural rather than a runtime guard someone can forget: in
    // CONNECTING, WAITING_PEER and CONNECTED this composable is not in the tree
    // at all, so there is no button to press and no state to race the session.
    UpdateRow(viewModel)
}

// ── updates ─────────────────────────────────────────────────────────────────

/**
 * The installed version, a manual check, and whatever the last check said.
 *
 * No automatic check runs here. `LaunchedEffect` is deliberately absent: the
 * only thing that starts a check is the button, which is what "manual" means
 * and what keeps this app free of any background network behaviour it would
 * then have to describe.
 */
@Composable
private fun UpdateRow(viewModel: TransferViewModel) {
    val updates = viewModel.updates
    val state by updates.state.collectAsStateWithLifecycle()
    val browserMissing by updates.browserMissingUrl.collectAsStateWithLifecycle()

    HorizontalDivider(Modifier.padding(top = 4.dp))

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.update_installed_version, BuildConfig.VERSION_NAME),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (state is UpdateChecker.UpdateUi.Checking) {
                // Cancel replaces Check while a request is in flight, so the
                // control is never a dead disabled button.
                TextButton(
                    onClick = updates::cancel,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                ) {
                    Text(stringResource(R.string.update_cancel))
                }
            } else {
                TextButton(
                    onClick = updates::check,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                ) {
                    Text(stringResource(R.string.update_check))
                }
            }
        }

        // One live region for every outcome: a screen reader announces the
        // result of a check the user asked for, rather than leaving it to be
        // discovered by exploration.
        val updateStatusLabel = stringResource(R.string.cd_update_status)
        val status = Modifier
            .fillMaxWidth()
            .semantics {
                contentDescription = updateStatusLabel
                liveRegion = LiveRegionMode.Polite
            }

        when (val s = state) {
            is UpdateChecker.UpdateUi.Idle -> Unit

            is UpdateChecker.UpdateUi.Checking -> Row(
                modifier = status,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(Modifier.height(20.dp).width(20.dp), strokeWidth = 2.dp)
                Text(
                    text = stringResource(R.string.update_checking),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }

            is UpdateChecker.UpdateUi.UpToDate -> Box(status) {
                StatusCard(
                    text = stringResource(R.string.update_up_to_date, s.installedVersionName),
                    isError = false,
                )
            }

            is UpdateChecker.UpdateUi.NoneDistributed -> Box(status) {
                StatusCard(text = stringResource(R.string.update_none), isError = false)
            }

            is UpdateChecker.UpdateUi.Failed -> Box(status) {
                StatusCard(text = stringResource(updateErrorText(s.error)), isError = true)
            }

            is UpdateChecker.UpdateUi.Available -> Card(modifier = status) {
                Column(
                    Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        text = stringResource(R.string.update_available, s.versionName),
                        style = MaterialTheme.typography.titleSmall,
                    )
                    if (s.note.isNotBlank()) {
                        Text(
                            text = stringResource(R.string.update_notes_title),
                            style = MaterialTheme.typography.labelLarge,
                        )
                        // PLAIN TEXT. The note comes off the network, so it is
                        // rendered as prose and nothing in it is made tappable
                        // — a link in a release note would be a tap target a
                        // feed author chose, which is the one thing this
                        // screen must not hand out.
                        Text(text = s.note, style = MaterialTheme.typography.bodyMedium)
                    }
                    Text(
                        text = stringResource(R.string.update_download_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    // defaultMinSize, NOT height: 52dp is the touch target, not
                    // a ceiling. "Open the download page" is a long label, and at
                    // font scale 2 on a 320dp screen a fixed height clips it —
                    // the Chinese string is short enough to hide that entirely,
                    // which is why the acceptance covers English at that size too.
                    Button(
                        onClick = updates::download,
                        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
                    ) {
                        Text(stringResource(R.string.update_download))
                    }
                    // Only after a launch actually failed: the address as
                    // selectable text, so a device with no browser leaves the
                    // user with something they can act on instead of a button
                    // that silently does nothing.
                    browserMissing?.let { url ->
                        Text(
                            text = stringResource(R.string.update_no_browser),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                        SelectionContainer {
                            Text(
                                text = url,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** Update failures → localised copy. */
private fun updateErrorText(error: UpdateChecker.UpdateError): Int = when (error) {
    UpdateChecker.UpdateError.NETWORK -> R.string.update_error_network
    UpdateChecker.UpdateError.TIMEOUT -> R.string.update_error_timeout
    UpdateChecker.UpdateError.SERVER -> R.string.update_error_server
    UpdateChecker.UpdateError.TOO_LARGE -> R.string.update_error_too_large
    UpdateChecker.UpdateError.MALFORMED -> R.string.update_error_malformed
    UpdateChecker.UpdateError.UNTRUSTED -> R.string.update_error_untrusted
}

// ── creating ────────────────────────────────────────────────────────────────

/**
 * Minting a link, and the honest reason when this device cannot.
 *
 * Creating needs an account and joining does not, and that asymmetry is the
 * server's, not a paywall this screen invented: whatever the room relays is
 * metered against the creating account's monthly allowance, so `POST /api/pair`
 * refuses an anonymous caller. The copy says that rather than showing a
 * disabled button — and says allowance rather than billing, because a mint
 * costs nothing.
 */
@Composable
private fun CreateCard(viewModel: TransferViewModel, onOpenAccount: () -> Unit) {
    val account by viewModel.account.state.collectAsStateWithLifecycle()
    val create by viewModel.createLink.state.collectAsStateWithLifecycle()

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = stringResource(R.string.create_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = stringResource(R.string.create_intro),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            if (account !is AccountState.Ready) {
                Text(
                    text = stringResource(R.string.create_needs_account),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Button(
                    onClick = onOpenAccount,
                    modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
                ) {
                    Text(stringResource(R.string.create_open_account))
                }
                return@Column
            }

            when (val c = create) {
                is CreateLinkModel.State.Minting -> Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(Modifier.height(20.dp).width(20.dp), strokeWidth = 2.dp)
                    Text(
                        text = stringResource(R.string.create_minting),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }

                else -> {
                    if (c is CreateLinkModel.State.Failed) {
                        StatusCard(text = accountErrorMessage(c.failure), isError = true)
                    }
                    // A code that was minted and then could not be used. Said
                    // out loud rather than dropped: the user asked for digits
                    // and got none, and a button that silently does nothing
                    // reads as a broken one.
                    if (c is CreateLinkModel.State.Superseded) {
                        StatusCard(text = stringResource(R.string.create_superseded), isError = true)
                    }
                    Button(
                        onClick = viewModel::createCrossNetworkLink,
                        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
                    ) {
                        Text(stringResource(R.string.create_action))
                    }
                }
            }
        }
    }
}

/**
 * The six digits, the full link, and how long either is worth anything.
 *
 * Drawn only while this device is IN the room it minted — the connecting and
 * waiting phases — so a code can never be presented as "give these to the other
 * device" while nothing is listening on it. It disappears when the peer arrives,
 * because at that point the code has done its job.
 */
@Composable
private fun MintedCodeCard(showing: CreateLinkModel.State.Showing, viewModel: TransferViewModel) {
    // One tick a second, so the countdown is a reading rather than a stale
    // number. It costs nothing when this card is not on screen, because the
    // effect is scoped to the card being in the composition.
    val now by produceState(initialValue = System.currentTimeMillis() / 1000L, showing) {
        while (true) {
            value = System.currentTimeMillis() / 1000L
            delay(1_000L)
        }
    }
    val expiry = PairCodeExpiry.presentation(showing.expiresAt, now)
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    val context = androidx.compose.ui.platform.LocalContext.current
    var copied by rememberSaveable { mutableStateOf(false) }
    // The confirmation belongs to ONE copy; a later change of what is on screen
    // must not leave it standing.
    LaunchedEffect(showing.code, expiry.usable) { copied = false }

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = stringResource(R.string.create_code_title),
                style = MaterialTheme.typography.titleMedium,
            )
            if (!expiry.usable) {
                // The server refuses the code from this second onward, so the
                // digits are not shown at all: a person reading an expired code
                // aloud gets a "code not found" on the other device and no way
                // to tell which of the two ends is wrong.
                StatusCard(text = stringResource(R.string.create_code_expired), isError = true)
                return@Column
            }
            SelectionContainer {
                Text(
                    text = showing.code,
                    style = MonospaceDigits,
                    modifier = Modifier.fillMaxWidth().semantics {
                        // Read as digits rather than as one large number.
                        contentDescription = showing.code.toCharArray().joinToString(" ")
                    },
                    textAlign = TextAlign.Center,
                )
            }
            expiry.countdown?.let { countdown ->
                Text(
                    text = stringResource(R.string.create_code_expires_in, countdown),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                text = stringResource(R.string.create_code_hint),
                style = MaterialTheme.typography.bodyMedium,
            )
            SelectionContainer {
                Text(
                    text = showing.link,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(
                    onClick = {
                        clipboard.setText(androidx.compose.ui.text.AnnotatedString(showing.link))
                        copied = true
                    },
                    modifier = Modifier.weight(1f).defaultMinSize(minHeight = 48.dp),
                ) {
                    Text(stringResource(R.string.create_copy_link))
                }
                OutlinedButton(
                    onClick = {
                        // The system sheet, with no target chosen for the user:
                        // whichever app they pick is the one that receives it.
                        val send = android.content.Intent(android.content.Intent.ACTION_SEND)
                            .setType("text/plain")
                            .putExtra(android.content.Intent.EXTRA_TEXT, showing.link)
                        runCatching {
                            context.startActivity(
                                android.content.Intent.createChooser(send, null),
                            )
                        }
                    },
                    modifier = Modifier.weight(1f).defaultMinSize(minHeight = 48.dp),
                ) {
                    Text(stringResource(R.string.create_share_link))
                }
            }
            if (copied) {
                Text(
                    text = stringResource(R.string.create_copied),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
        }
    }
}

// ── connecting ──────────────────────────────────────────────────────────────

@Composable
private fun ConnectingScreen(
    state: TransferController.State,
    viewModel: TransferViewModel,
) {
    val create by viewModel.createLink.state.collectAsStateWithLifecycle()

    // The code THIS device minted for the room it is now sitting in. Any other
    // create state — including a code minted for a session that has since been
    // replaced — draws nothing; `TransferViewModel.join` retires it, so a
    // session started from a pasted code never shows one.
    (create as? CreateLinkModel.State.Showing)?.let { showing ->
        MintedCodeCard(showing, viewModel)
    }

    Spacer(Modifier.height(24.dp))
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        CircularProgressIndicator()
        Text(
            text = when (state.phase) {
                TransferController.Phase.WAITING_PEER ->
                    stringResource(R.string.status_waiting_peer)
                else -> stringResource(R.string.status_connecting)
            },
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
        )
        OutlinedButton(
            onClick = viewModel::disconnect,
            modifier = Modifier.height(48.dp),
        ) {
            Text(stringResource(R.string.files_cancel))
        }
    }
}

// ── shared pieces ───────────────────────────────────────────────────────────

@Composable
internal fun StatusCard(text: String, isError: Boolean) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (isError) {
                MaterialTheme.colorScheme.errorContainer
            } else {
                MaterialTheme.colorScheme.surfaceVariant
            },
        ),
    ) {
        Text(
            text = text,
            modifier = Modifier.padding(16.dp),
            color = if (isError) {
                MaterialTheme.colorScheme.onErrorContainer
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
private fun CleanupWarningCard(onDismiss: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
        ),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = stringResource(R.string.cleanup_incomplete),
                color = MaterialTheme.colorScheme.onErrorContainer,
                style = MaterialTheme.typography.bodyMedium,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss, modifier = Modifier.height(48.dp)) {
                    Text(stringResource(R.string.cleanup_dismiss))
                }
            }
        }
    }
}

/** Controller error keys → localised copy. An unknown key falls back to the
 *  generic transfer failure rather than crashing on a resource id. */
internal fun errorText(key: String): Int = when (key) {
    "error_code_not_found" -> R.string.error_code_not_found
    "error_network" -> R.string.error_network
    "error_peer_busy" -> R.string.error_peer_busy
    "error_peer_incompatible" -> R.string.error_peer_incompatible
    "error_handshake" -> R.string.error_handshake
    "error_connection_lost" -> R.string.error_connection_lost
    "error_integrity" -> R.string.error_integrity
    "error_save_failed" -> R.string.error_save_failed
    "error_no_space" -> R.string.error_no_space
    "error_unsafe_path" -> R.string.error_unsafe_path
    "error_text_failed" -> R.string.error_text_failed
    "error_text_buffer_full" -> R.string.error_text_buffer_full
    "error_text_refused" -> R.string.error_text_refused
    "error_legacy_no_offer" -> R.string.error_legacy_no_offer
    "error_nearby_unavailable" -> R.string.error_nearby_unavailable
    else -> R.string.error_transfer_failed
}

private fun joinErrorText(reason: JoinInput.Result.Reason): Int = when (reason) {
    JoinInput.Result.Reason.EMPTY -> R.string.join_error_empty
    JoinInput.Result.Reason.NOT_SIX_DIGITS -> R.string.join_error_digits
    JoinInput.Result.Reason.FOREIGN_ORIGIN -> R.string.join_error_origin
    JoinInput.Result.Reason.STORED_LINK -> R.string.join_error_stored
    JoinInput.Result.Reason.NO_CODE_IN_LINK -> R.string.join_error_link
}

// ── things another app handed us ────────────────────────────────────────────

/**
 * Why something handed to this app was refused, as copy.
 *
 * A closed mapping from the module's own enum: the reason never quotes the
 * input, so a hostile link's contents cannot reach the screen or a log.
 */
@Composable
internal fun ingressRefusalText(reason: IngressRefusal): Int = when (reason) {
    IngressRefusal.EMPTY -> R.string.ingress_refused_empty
    IngressRefusal.MALFORMED_LINK -> R.string.ingress_refused_malformed_link
    IngressRefusal.CREDENTIALS_IN_LINK -> R.string.ingress_refused_credentials
    IngressRefusal.FOREIGN_ORIGIN -> R.string.ingress_refused_foreign_origin
    IngressRefusal.UNSUPPORTED_PATH -> R.string.ingress_refused_unsupported_path
    IngressRefusal.NO_CODE_IN_LINK -> R.string.ingress_refused_no_code
    IngressRefusal.CODE_NOT_SIX_DIGITS -> R.string.ingress_refused_not_six_digits
    IngressRefusal.STORED_LINK_INVALID -> R.string.ingress_refused_stored_link
    IngressRefusal.NOTHING_SHAREABLE -> R.string.ingress_refused_nothing_shareable
    IngressRefusal.MALFORMED_INTENT -> R.string.ingress_refused_malformed_intent
    IngressRefusal.TOO_MANY_ITEMS -> R.string.ingress_refused_too_many
    IngressRefusal.TEXT_TOO_LONG -> R.string.ingress_refused_text_too_long
}

/** Why one item of a share was dropped while the others were kept. */
@Composable
private fun shareSkippedText(reason: ShareItemRefusal): Int = when (reason) {
    ShareItemRefusal.NO_READ_GRANT -> R.string.share_skipped_no_grant
    ShareItemRefusal.UNSUPPORTED_SCHEME -> R.string.share_skipped_scheme
    ShareItemRefusal.NO_AUTHORITY -> R.string.share_skipped_no_authority
    ShareItemRefusal.USER_QUALIFIED_AUTHORITY -> R.string.share_skipped_user_qualified
    ShareItemRefusal.OWN_PROVIDER -> R.string.share_skipped_own_provider
    ShareItemRefusal.DUPLICATE -> R.string.share_skipped_duplicate
}

/**
 * Something is staged and the user is looking somewhere else.
 *
 * Without this the share would be held with no way back to it, which is worse
 * than never having accepted it: the app would be keeping a grant over
 * somebody's document for a screen the user cannot reach.
 */
@Composable
private fun StagedShareBanner(staged: IngressHost.Staged, onOpen: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = when (staged.kind) {
                    IngressHost.Staged.Kind.TEXT -> stringResource(R.string.share_banner_text)
                    IngressHost.Staged.Kind.FILES -> pluralStringResource(
                        R.plurals.share_banner_files,
                        staged.itemCount,
                        staged.itemCount,
                    )
                },
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
            Button(
                onClick = onOpen,
                modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
            ) {
                Text(stringResource(R.string.share_banner_action))
            }
        }
    }
}

/**
 * What was shared, and the destinations it can be sent to.
 *
 * ## Nothing here sends on arrival
 *
 * Every destination is a button. The app received references and a description;
 * the transfer starts when a person chooses where it goes. An app that auto-sent
 * on intent delivery would be uploading somebody's photo the moment they
 * mis-tapped a share sheet.
 *
 * ## What it says about the content is what it actually knows
 *
 * A provider that would not answer gets "name unavailable" and "size unknown"
 * rather than an invented name or a zero. Items admission dropped are counted
 * with their reason, because a share that quietly became shorter is a share the
 * user will believe was sent whole.
 *
 * ## Account-bound destinations are gated, not hidden
 *
 * Cloud and Inbox need a credential. Signed out, they say so and offer the way
 * to sign in — the share survives that trip, because staging identity is
 * deliberately not the account's. A hidden control would read as a destination
 * this build does not have.
 */
@Composable
private fun ShareSurface(
    staged: IngressHost.Staged,
    state: TransferController.State,
    viewModel: TransferViewModel,
    onDismiss: () -> Unit,
    onOpenAccount: () -> Unit,
) {
    val account by viewModel.account.state.collectAsStateWithLifecycle()
    val inbox by viewModel.inbox.collectAsStateWithLifecycle()
    val signedIn = account is AccountState.Ready
    val connected = state.phase == TransferController.Phase.CONNECTED

    Text(
        text = stringResource(R.string.share_title),
        style = MaterialTheme.typography.headlineSmall,
    )

    Card {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            when (staged.kind) {
                IngressHost.Staged.Kind.TEXT -> {
                    Text(
                        text = stringResource(R.string.share_text_title),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    // The user's own message, selectable and never persisted.
                    SelectionContainer {
                        Text(
                            text = staged.text.orEmpty(),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
                IngressHost.Staged.Kind.FILES -> {
                    Text(
                        text = pluralStringResource(
                            R.plurals.share_files_title,
                            staged.itemCount,
                            staged.itemCount,
                        ),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    val items = staged.items
                    if (items == null) {
                        // The descriptions are being read off the main thread.
                        // The count is already true, so it is shown rather than
                        // replacing the card with a spinner.
                        Text(
                            text = stringResource(R.string.share_reading),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        for (item in items) {
                            Text(
                                text = item.displayName
                                    ?: stringResource(R.string.share_item_unnamed),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                text = item.size?.let { formatBytes(it) }
                                    ?: stringResource(R.string.share_item_unknown_size),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    for ((reason, count) in staged.skipped) {
                        Text(
                            text = pluralStringResource(
                                R.plurals.share_skipped,
                                count,
                                count,
                                stringResource(shareSkippedText(reason)),
                            ),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }

    Text(
        text = stringResource(R.string.share_destination_title),
        style = MaterialTheme.typography.titleMedium,
    )

    if (staged.kind == IngressHost.Staged.Kind.TEXT) {
        // A message goes into the session's draft, where the user still presses
        // Send — the same control a typed message uses, so there is one send
        // path rather than two.
        DestinationButton(
            label = stringResource(R.string.share_text_to_draft),
            enabled = connected,
            unavailable = if (connected) null else stringResource(R.string.share_needs_session),
            onClick = { viewModel.dispatchStagedTextToSession(); onDismiss() },
        )
    } else {
        DestinationButton(
            label = stringResource(R.string.share_to_session),
            enabled = connected,
            unavailable = if (connected) null else stringResource(R.string.share_needs_session),
            onClick = { viewModel.dispatchStagedToSession(staged.id); onDismiss() },
        )
        DestinationButton(
            label = stringResource(R.string.share_to_cloud),
            enabled = signedIn,
            unavailable = if (signedIn) null else stringResource(R.string.share_needs_account),
            onClick = { viewModel.dispatchStagedToCloud(staged.id); onDismiss() },
        )
    }

    // The Inbox needs a device as well as an account: a delivery is addressed,
    // and offering "send to Inbox" with nothing to send to would be a button
    // that cannot work.
    if (!signedIn) {
        DestinationButton(
            label = stringResource(R.string.share_to_inbox),
            enabled = false,
            unavailable = stringResource(R.string.share_needs_account),
            onClick = {},
        )
        OutlinedButton(
            onClick = onOpenAccount,
            modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
        ) {
            Text(stringResource(R.string.share_sign_in))
        }
    } else {
        val targets = if (staged.kind == IngressHost.Staged.Kind.TEXT) {
            // Only devices that announced they can PRESENT a message. Writing a
            // `.txt` facsimile on a device that cannot is the dishonest half of
            // the feature.
            inbox.devices.filter { it.deviceId in inbox.textCapableDevices }
        } else {
            inbox.devices
        }
        if (targets.isEmpty()) {
            DestinationButton(
                label = stringResource(R.string.share_to_inbox),
                enabled = false,
                unavailable = stringResource(R.string.share_inbox_no_devices),
                onClick = {},
            )
        } else {
            Text(
                text = stringResource(R.string.share_to_inbox),
                style = MaterialTheme.typography.bodyMedium,
            )
            for (target in targets) {
                DestinationButton(
                    label = target.name,
                    enabled = true,
                    unavailable = null,
                    onClick = {
                        if (staged.kind == IngressHost.Staged.Kind.TEXT) {
                            viewModel.dispatchStagedTextToInbox(target)
                        } else {
                            viewModel.dispatchStagedToInbox(staged.id, target)
                        }
                        onDismiss()
                    },
                )
            }
        }
    }

    HorizontalDivider()

    // Cancelling RELEASES the grants rather than merely hiding the screen: a
    // share nobody will dispatch is a claim on somebody's document that this
    // app should not keep.
    TextButton(onClick = { viewModel.cancelStagedShare(); onDismiss() }) {
        Text(stringResource(R.string.share_discard))
    }
}

/**
 * One destination, with the reason it cannot be used when it cannot.
 *
 * Disabled and explained rather than absent: a missing button reads as a
 * feature this build does not have, and the user has already chosen to send
 * something here.
 */
@Composable
private fun DestinationButton(
    label: String,
    enabled: Boolean,
    unavailable: String?,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
    ) {
        Text(label)
    }
    unavailable?.let {
        Text(
            text = it,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// Sizes are rendered with the session surface's own `formatBytes`: one spelling
// of "how big is this" across the whole app, rather than a second one here that
// would eventually disagree with it.

// ── the Device Inbox, wired to the real feature ─────────────────────────────

/**
 * The Inbox surface with the host integrations the component cannot own.
 *
 * `InboxActions.open`, `export` and `share` are nullable in the accepted
 * component precisely because they need a system integration it does not have —
 * a content provider, a share sheet, a document tree. A host that left them null
 * would get no controls, which is honest but incomplete; this supplies real
 * ones, so a received delivery can actually be opened, saved somewhere the user
 * chooses, or handed to another app.
 *
 * ## Every asynchronous step re-checks the account
 *
 * Locating an entry, minting a grant and copying into a chosen folder all
 * suspend, and the account can be switched or signed out inside any of them.
 * The ViewModel re-checks the binding after each await and answers with nothing
 * rather than acting — so a URI is never handed to another app on behalf of a
 * session that has ended, and an export never writes one account's delivery
 * during another's.
 *
 * ## The export destination is a real picker, under the same bounded lease
 *
 * Choosing a folder stops this Activity exactly as any other picker does, so it
 * takes a lease. It is a DATA claim: nothing is being advertised to anybody
 * while the user browses, so an expiry ends the covered state without
 * discarding the folder they chose.
 */
/**
 * The Inbox surface's two system round trips, as callbacks it invokes.
 *
 * A holder for the same reason [Pickers] is one: the launchers themselves are
 * registered above the destination switch, so their registration outlives a tab
 * change and an Activity recreation, and the caller passes the identity the
 * launch is happening under rather than anything downstream re-deriving it.
 */
internal class InboxPickers(
    val chooseFiles: (InboxSendTarget) -> Unit,
    val chooseFolder: (entryId: String) -> Unit,
)

@Composable
private fun InboxDestination(
    viewModel: TransferViewModel,
    pickers: InboxPickers,
    notice: Int?,
    onNotice: (Int?) -> Unit,
    onOpenAccount: () -> Unit,
) {
    val state by viewModel.inbox.collectAsStateWithLifecycle()
    val unusable by viewModel.inboxAccountUnusable.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val actions = remember(viewModel, pickers) {
        InboxActions(
            signIn = onOpenAccount,
            retry = { viewModel.inboxRefresh() },
            setPolicy = { viewModel.inboxSetPolicy(it) },
            respond = { taskId, accept -> viewModel.inboxRespond(taskId, accept) },
            repairKey = { viewModel.inboxRepairKey() },
            chooseFiles = { target -> pickers.chooseFiles(target) },
            sendText = { target, text -> viewModel.inboxSendText(target, text) },
            send = { viewModel.inboxSend(it) },
            cancelSend = { viewModel.inboxCancelSend(it) },
            markRead = { viewModel.inboxMarkRead(it) },
            delete = { viewModel.inboxDelete(it) },
            loadMessage = { entry -> viewModel.inboxMessage(entry) },
            open = { entry ->
                scope.launch {
                    val uris = viewModel.inboxGrantFiles(entry)
                    val first = uris.firstOrNull()
                    onNotice(
                        if (first == null) {
                            R.string.inbox_export_unavailable
                        } else {
                            val intent = android.content.Intent(android.content.Intent.ACTION_VIEW)
                                .setDataAndType(first, context.contentResolver.getType(first))
                                // The grant the receiving app reads under.
                                // Without it the provider is unreachable —
                                // which is the point: nothing is exported, one
                                // app is let in.
                                .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            // Attempted rather than asked about.
                            // `resolveActivity` needs a `<queries>` declaration
                            // — a standing statement about which other apps
                            // this one may see — for a question the launch's own
                            // outcome already answers.
                            try {
                                context.startActivity(intent)
                                null
                            } catch (_: android.content.ActivityNotFoundException) {
                                R.string.inbox_open_no_app
                            }
                        },
                    )
                }
            },
            export = { entry -> pickers.chooseFolder(entry.id) },
            share = { entry ->
                scope.launch {
                    val uris = viewModel.inboxGrantFiles(entry)
                    onNotice(
                        if (uris.isEmpty()) {
                            R.string.inbox_export_unavailable
                        } else {
                            val intent = if (uris.size == 1) {
                                android.content.Intent(android.content.Intent.ACTION_SEND)
                                    .setType(context.contentResolver.getType(uris[0]))
                                    .putExtra(android.content.Intent.EXTRA_STREAM, uris[0])
                            } else {
                                android.content.Intent(android.content.Intent.ACTION_SEND_MULTIPLE)
                                    .setType("*/*")
                                    .putParcelableArrayListExtra(
                                        android.content.Intent.EXTRA_STREAM,
                                        ArrayList(uris),
                                    )
                            }.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            context.startActivity(
                                android.content.Intent.createChooser(intent, null),
                            )
                            null
                        },
                    )
                }
            },
        )
    }

    if (unusable) {
        StatusCard(text = stringResource(R.string.inbox_account_unusable), isError = true)
    }
    // An export stopped by an account change cannot tell the coroutine that was
    // awaiting it — that coroutine went with it. This is how the fact still
    // reaches the person whose folder now holds files this app could not remove.
    val leftovers by viewModel.exportCleanup.collectAsStateWithLifecycle()
    leftovers?.let {
        StatusCard(text = stringResource(R.string.inbox_export_incomplete), isError = true)
        TextButton(onClick = viewModel::clearExportCleanup) {
            Text(stringResource(R.string.ingress_dismiss))
        }
    }
    notice?.let { message ->
        StatusCard(text = stringResource(message), isError = false)
        TextButton(onClick = { onNotice(null) }) {
            Text(stringResource(R.string.ingress_dismiss))
        }
    }
    InboxScreen(state, actions)
}
