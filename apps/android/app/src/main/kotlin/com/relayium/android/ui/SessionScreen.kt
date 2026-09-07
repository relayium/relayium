package com.relayium.android.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.relayium.android.R
import com.relayium.android.TransferController
import com.relayium.android.TransferViewModel
import com.relayium.protocol.TextLaneSession

/**
 * The connected session: verification first, then two clearly separate
 * capabilities — files and messages. The CONNECTION was made by the pairing
 * code; the SAS card explains that sending anything is a second, deliberate
 * step, so a user who only wanted to check the link isn't pushed into one.
 */
@Composable
internal fun SessionScreen(
    state: TransferController.State,
    pickError: TransferViewModel.PickError?,
    viewModel: TransferViewModel,
) {
    VerificationCard(state, viewModel)
    FilesCard(state, pickError, viewModel)
    MessagesCard(state, viewModel)
}

// ── verification ────────────────────────────────────────────────────────────

@Composable
private fun VerificationCard(
    state: TransferController.State,
    viewModel: TransferViewModel,
) {
    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = stringResource(R.string.status_connected),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.secondary,
            )
            state.sas?.let { sas ->
                Text(
                    text = stringResource(R.string.status_verification_code, ""),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    text = sas,
                    style = MonospaceDigits,
                    modifier = Modifier.align(Alignment.CenterHorizontally),
                )
            }
            Text(
                text = stringResource(R.string.status_verification_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = viewModel::disconnect, modifier = Modifier.height(48.dp)) {
                    Text(stringResource(R.string.status_disconnect))
                }
            }
        }
    }
}

// ── files ───────────────────────────────────────────────────────────────────

@Composable
private fun FilesCard(
    state: TransferController.State,
    pickError: TransferViewModel.PickError?,
    viewModel: TransferViewModel,
) {
    // The controller-owned link identity each picker result must be handed
    // back with. Captured AT LAUNCH and saved across the picker round-trip;
    // the CONTROLLER compares it on its session executor before any lane
    // mutation, so a file chosen for one connection can never be sent on the
    // next, and a folder chosen for one offer can never accept another (the
    // controller's promptId is the second fence).
    var sendLinkId by rememberSaveable { mutableIntStateOf(0) }
    var saveLinkId by rememberSaveable { mutableIntStateOf(0) }
    var savePromptId by rememberSaveable { mutableIntStateOf(0) }

    val filePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris -> viewModel.sendPicked(uris, sendLinkId) }

    val folderPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocumentTree(),
    ) { tree -> viewModel.acceptIncoming(savePromptId, tree, saveLinkId) }

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = stringResource(R.string.files_title),
                style = MaterialTheme.typography.titleMedium,
            )

            if (state.fileLaneDown) {
                StatusCard(text = stringResource(R.string.files_lane_down), isError = true)
                return@Column
            }

            // ── incoming ────────────────────────────────────────────────────
            // The batch stays visible from the offer until COMPLETE or discard:
            // `incoming` is only emptied by those exits, so this one block is
            // the truthful "a batch is in flight" surface. Between accepting
            // and the first durable chunk — and for a zero-byte file waiting on
            // its DONE — there IS no progress row, and the receive must still
            // be cancellable; a cancel control gated on progress bytes would
            // claim the accepted transfer cannot be stopped.
            if (state.incoming.isNotEmpty()) {
                Text(
                    text = stringResource(R.string.files_incoming_title),
                    style = MaterialTheme.typography.titleSmall,
                )
                state.incoming.forEach { meta ->
                    Text(
                        text = "${meta.name} — ${formatBytes(meta.size)}",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                Text(
                    text = pluralStringResource(
                        R.plurals.files_incoming_summary,
                        state.incoming.size,
                        state.incoming.size,
                        formatBytes(state.incoming.sumOf { it.size }),
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (state.awaitingFolder) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Button(
                            onClick = {
                                saveLinkId = state.linkId
                                savePromptId = state.promptId
                                folderPicker.launch(null)
                            },
                            modifier = Modifier
                                .weight(1f)
                                .height(48.dp),
                        ) {
                            Text(stringResource(R.string.files_choose_folder))
                        }
                        OutlinedButton(
                            onClick = viewModel::rejectIncoming,
                            modifier = Modifier.height(48.dp),
                        ) {
                            Text(stringResource(R.string.files_decline))
                        }
                    }
                } else {
                    val progress = state.receiveProgress
                    if (progress != null) {
                        Text(
                            text = stringResource(R.string.files_receiving, progress.name),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        TransferProgress(progress)
                    } else {
                        Text(
                            text = stringResource(R.string.files_receive_waiting),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    OutlinedButton(
                        onClick = viewModel::cancelReceive,
                        modifier = Modifier.height(48.dp),
                    ) {
                        Text(stringResource(R.string.files_cancel))
                    }
                }
                HorizontalDivider()
            }

            if (state.savedBatch) {
                StatusCard(text = stringResource(R.string.files_saved), isError = false)
            }

            // ── outgoing ────────────────────────────────────────────────────
            if (state.outgoing.isEmpty()) {
                Button(
                    onClick = {
                        sendLinkId = state.linkId
                        filePicker.launch(arrayOf("*/*"))
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(48.dp),
                ) {
                    Text(stringResource(R.string.files_pick))
                }
            } else {
                state.outgoing.forEach { meta ->
                    Text(
                        text = "${meta.name} — ${formatBytes(meta.size)}",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                val progress = state.sendProgress
                if (progress != null) {
                    Text(
                        text = stringResource(R.string.files_sending, progress.name),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    TransferProgress(progress)
                } else {
                    Text(
                        text = stringResource(R.string.files_waiting_accept),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                OutlinedButton(
                    onClick = viewModel::cancelSend,
                    modifier = Modifier.height(48.dp),
                ) {
                    Text(stringResource(R.string.files_cancel))
                }
            }

            // Success text comes from the peer's verified COMPLETE
            // (state.sentBatch) and never from progress merely clearing.
            if (state.sentBatch) {
                StatusCard(text = stringResource(R.string.files_sent_batch), isError = false)
            }

            // Only THIS link's picker failure: an old pick's error must not
            // surface against a new peer.
            pickError?.takeIf { it.linkId == state.linkId }?.let { error ->
                StatusCard(
                    text = when (error.kind) {
                        TransferViewModel.PickError.Kind.UNKNOWN_SIZE ->
                            stringResource(R.string.picker_unknown_size, error.name ?: "")
                        TransferViewModel.PickError.Kind.UNREADABLE ->
                            stringResource(R.string.picker_unreadable)
                        TransferViewModel.PickError.Kind.FOLDER_UNAVAILABLE ->
                            stringResource(R.string.picker_folder_unavailable)
                    },
                    isError = true,
                )
                TextButton(
                    onClick = viewModel::clearPickError,
                    modifier = Modifier.height(48.dp),
                ) {
                    Text(stringResource(R.string.cleanup_dismiss))
                }
            }

            // A live in-session error (save failure, integrity, …) that did not
            // end the link is shown where the transfer state is.
            state.errorKey?.let { key ->
                StatusCard(text = stringResource(errorText(key)), isError = true)
            }
        }
    }
}

@Composable
private fun TransferProgress(progress: TransferController.Progress) {
    val cd = stringResource(R.string.cd_progress)
    LinearProgressIndicator(
        progress = {
            if (progress.total <= 0L) 0f
            else (progress.done.toDouble() / progress.total).toFloat().coerceIn(0f, 1f)
        },
        modifier = Modifier
            .fillMaxWidth()
            .semantics { contentDescription = cd },
    )
    Text(
        text = stringResource(
            R.string.files_progress,
            formatBytes(progress.done),
            formatBytes(progress.total),
        ),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

// ── messages ────────────────────────────────────────────────────────────────

@Composable
private fun MessagesCard(
    state: TransferController.State,
    viewModel: TransferViewModel,
) {
    // The draft lives in the ViewModel, NOT in rememberSaveable: saved
    // instance state is written outside the app's memory, and the text
    // contract is that message plaintext never leaves this process. The
    // ViewModel also owns when it clears — only after the controller confirms
    // this exact text entered the channel (see TransferViewModel.sendDraft).
    //
    // It is also OWNED BY A LINK. This composable renders the draft only while
    // it belongs to the connection being rendered, so a previous peer's text
    // is never displayed against a new one — and the link identity read here
    // is the one handed back to every edit and to Send, where the controller
    // re-checks it on its session executor before sealing anything.
    val draftState by viewModel.draft.collectAsStateWithLifecycle()
    val renderedLink = state.linkId
    val draft = if (draftState.linkId == renderedLink) draftState.text else ""

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = stringResource(R.string.text_title),
                style = MaterialTheme.typography.titleMedium,
            )

            when (state.textState) {
                TextLaneSession.State.OPEN -> {
                    if (state.messages.isEmpty()) {
                        Text(
                            text = stringResource(R.string.text_empty),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        val listCd = stringResource(R.string.cd_message_list)
                        Column(
                            modifier = Modifier.semantics { contentDescription = listCd },
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            state.messages.forEach { message ->
                                MessageRow(message)
                            }
                        }
                    }
                    val bytes = draft.toByteArray(Charsets.UTF_8).size
                    val tooLong = bytes > state.textLimit
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { viewModel.updateDraft(it, renderedLink) },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text(stringResource(R.string.text_field_label)) },
                        isError = tooLong,
                        supportingText = if (tooLong) {
                            { Text(stringResource(R.string.text_too_long, bytes, state.textLimit)) }
                        } else {
                            null
                        },
                    )
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Button(
                            onClick = { viewModel.sendDraft(renderedLink) },
                            enabled = draft.isNotBlank() && !tooLong,
                            modifier = Modifier
                                .weight(1f)
                                .height(48.dp),
                        ) {
                            Text(stringResource(R.string.text_send))
                        }
                        TextButton(
                            onClick = viewModel::endText,
                            modifier = Modifier.height(48.dp),
                        ) {
                            Text(stringResource(R.string.text_end))
                        }
                    }
                }

                TextLaneSession.State.INCOMING_REQUEST -> {
                    Text(
                        text = stringResource(R.string.text_incoming_request),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Button(
                            onClick = viewModel::acceptText,
                            modifier = Modifier
                                .weight(1f)
                                .height(48.dp),
                        ) {
                            Text(stringResource(R.string.text_accept))
                        }
                        OutlinedButton(
                            onClick = viewModel::rejectText,
                            modifier = Modifier.height(48.dp),
                        ) {
                            Text(stringResource(R.string.text_decline))
                        }
                    }
                }

                TextLaneSession.State.REQUESTED -> {
                    Text(
                        text = stringResource(R.string.text_requested),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                TextLaneSession.State.IDLE, TextLaneSession.State.ENDED -> {
                    if (state.textState == TextLaneSession.State.ENDED) {
                        Text(
                            text = stringResource(R.string.text_ended),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Button(
                        onClick = viewModel::requestText,
                        enabled = state.textCanRequest,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(48.dp),
                    ) {
                        Text(stringResource(R.string.text_start))
                    }
                }

                TextLaneSession.State.FAILED -> {
                    StatusCard(text = stringResource(R.string.text_failed), isError = true)
                }
            }
        }
    }
}

@Composable
private fun MessageRow(message: TransferController.Message) {
    Column {
        Text(
            text = if (message.fromPeer) {
                stringResource(R.string.text_from_peer)
            } else {
                stringResource(R.string.text_from_me)
            },
            style = MaterialTheme.typography.labelSmall,
            color = if (message.fromPeer) {
                MaterialTheme.colorScheme.secondary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
        Text(text = message.body, style = MaterialTheme.typography.bodyMedium)
    }
}

// ── formatting ──────────────────────────────────────────────────────────────

/** Human sizes, binary units, one decimal above KiB. Locale-safe: the digits
 *  come from String.format with the default locale. */
internal fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val units = listOf("KiB", "MiB", "GiB", "TiB")
    var value = bytes.toDouble()
    var unit = -1
    while (value >= 1024 && unit < units.lastIndex) {
        value /= 1024
        unit++
    }
    return String.format(java.util.Locale.getDefault(), "%.1f %s", value, units[unit])
}
