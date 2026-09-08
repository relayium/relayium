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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.relayium.android.BuildConfig
import com.relayium.android.R
import com.relayium.android.TransferController
import com.relayium.android.TransferViewModel
import com.relayium.android.account.AccountState
import com.relayium.android.account.CreateLinkModel
import com.relayium.android.account.PairCodeExpiry
import com.relayium.android.update.UpdateChecker
import com.relayium.protocol.JoinInput
import kotlinx.coroutines.delay

/** The two things this build can do, and nothing it cannot. There is no tab
 *  here for a feature that is not implemented: a destination that opens onto a
 *  placeholder is a claim the product does not honour. */
internal enum class Destination { TRANSFER, ACCOUNT }

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

    val filePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris -> viewModel.sendPicked(uris, sendLinkId) }

    val folderPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocumentTree(),
    ) { tree -> viewModel.acceptIncoming(savePromptId, tree, saveLinkId) }

    val pickers = Pickers(
        chooseFiles = { linkId ->
            sendLinkId = linkId
            filePicker.launch(arrayOf("*/*"))
        },
        chooseFolder = { linkId, promptId ->
            saveLinkId = linkId
            savePromptId = promptId
            folderPicker.launch(null)
        },
    )

    // Back returns to the transfer surface rather than leaving the app. Enabled
    // only off the transfer tab, so the system's own "back closes the app"
    // behaviour is untouched where it is the right one.
    BackHandler(enabled = destination != Destination.TRANSFER) {
        destination = Destination.TRANSFER
    }

    Scaffold(
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = destination == Destination.TRANSFER,
                    onClick = { destination = Destination.TRANSFER },
                    icon = { Icon(Icons.Filled.Send, contentDescription = null) },
                    label = { Text(stringResource(R.string.tab_transfer)) },
                )
                NavigationBarItem(
                    selected = destination == Destination.ACCOUNT,
                    onClick = { destination = Destination.ACCOUNT },
                    icon = { Icon(Icons.Filled.Person, contentDescription = null) },
                    label = { Text(stringResource(R.string.tab_account)) },
                )
            }
        },
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
                when (destination) {
                    Destination.TRANSFER -> when (state.phase) {
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
                    Destination.ACCOUNT -> AccountScreen(viewModel)
                }
            }
        }
    }
}

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
    var input by rememberSaveable { mutableStateOf("") }

    // Submitting hides the keyboard FIRST: at large font scales on a narrow
    // screen the field's supporting-text error can sit entirely below the IME,
    // and a Done that validates invisibly reads as a dead key. (Observed on
    // the 320dp/font-2 emulator pass; the join code itself is not sensitive
    // keyboard state.)
    val keyboard = LocalSoftwareKeyboardController.current
    val submit = {
        keyboard?.hide()
        viewModel.join(input)
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
        onValueChange = {
            input = it
            if (joinError != null) viewModel.clearJoinError()
        },
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
    else -> R.string.error_transfer_failed
}

private fun joinErrorText(reason: JoinInput.Result.Reason): Int = when (reason) {
    JoinInput.Result.Reason.EMPTY -> R.string.join_error_empty
    JoinInput.Result.Reason.NOT_SIX_DIGITS -> R.string.join_error_digits
    JoinInput.Result.Reason.FOREIGN_ORIGIN -> R.string.join_error_origin
    JoinInput.Result.Reason.STORED_LINK -> R.string.join_error_stored
    JoinInput.Result.Reason.NO_CODE_IN_LINK -> R.string.join_error_link
}
