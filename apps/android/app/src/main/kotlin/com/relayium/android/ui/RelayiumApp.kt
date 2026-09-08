package com.relayium.android.ui

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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
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
import com.relayium.android.update.UpdateChecker
import com.relayium.protocol.JoinInput

/**
 * One screen, routed by the controller's phase. The layout constants follow
 * the app-wide rhythm: 16dp card padding, 20dp between sections, a readable
 * max width on tablets, and every tappable target at least 48dp.
 */
@Composable
fun RelayiumApp(viewModel: TransferViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val joinError by viewModel.joinError.collectAsStateWithLifecycle()
    val pickError by viewModel.pickError.collectAsStateWithLifecycle()

    Scaffold { insets ->
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
                // Session-level, above everything: leftovers are real whatever
                // phase the link is in, and the warning stays until dismissed.
                if (state.cleanupIncomplete) {
                    CleanupWarningCard(onDismiss = viewModel::dismissCleanupWarning)
                }
                when (state.phase) {
                    TransferController.Phase.IDLE ->
                        JoinScreen(state, joinError, endedBanner = false, viewModel)
                    TransferController.Phase.ENDED ->
                        JoinScreen(state, joinError, endedBanner = true, viewModel)
                    TransferController.Phase.CONNECTING,
                    TransferController.Phase.WAITING_PEER,
                    -> ConnectingScreen(state, viewModel)
                    TransferController.Phase.CONNECTED ->
                        SessionScreen(state, pickError, viewModel)
                }
            }
        }
    }
}

// ── join ────────────────────────────────────────────────────────────────────

@Composable
private fun JoinScreen(
    state: TransferController.State,
    joinError: JoinInput.Result.Reason?,
    endedBanner: Boolean,
    viewModel: TransferViewModel,
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

// ── connecting ──────────────────────────────────────────────────────────────

@Composable
private fun ConnectingScreen(
    state: TransferController.State,
    viewModel: TransferViewModel,
) {
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
