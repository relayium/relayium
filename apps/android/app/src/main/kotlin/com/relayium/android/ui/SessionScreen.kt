package com.relayium.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
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
    pickers: Pickers,
) {
    VerificationCard(state, viewModel)
    // What this CONNECTION can carry, not what the app can do. A legacy peer
    // opens one generation per connection, so exactly one of these two cards is
    // a working surface and the other has to say why it is not — an enabled
    // control over a lane no frame can reach is the dead end this replaces.
    if (state.canSendFiles) {
        FilesCard(state, pickError, viewModel, pickers)
    } else {
        UnavailableLaneCard(R.string.files_title, R.string.files_legacy_unavailable)
    }
    if (state.canSendMessages) {
        MessagesCard(state, viewModel)
    } else {
        UnavailableLaneCard(R.string.text_title, R.string.text_legacy_unavailable)
    }
}

/** One capability this connection does not have, named and explained. */
@Composable
private fun UnavailableLaneCard(titleRes: Int, bodyRes: Int) {
    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(text = stringResource(titleRes), style = MaterialTheme.typography.titleMedium)
            Text(
                text = stringResource(bodyRes),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
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
            when (state.wire) {
                TransferController.Wire.LEGACY_FILES -> R.string.status_legacy_files
                TransferController.Wire.LEGACY_TEXT -> R.string.status_legacy_text
                else -> null
            }?.let { note ->
                Text(
                    text = stringResource(note),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
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
                TextButton(onClick = viewModel::disconnect, modifier = Modifier.heightIn(min = 48.dp)) {
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
    pickers: Pickers,
) {
    // The launchers themselves live in [RelayiumApp], ABOVE the destination
    // switch, so a tab change cannot unregister a picker whose result is still
    // to come. What is unchanged is the contract they carry: the link (and, for
    // a folder, the prompt) captured AT LAUNCH and compared by the CONTROLLER on
    // its session executor before any lane mutation, so a file chosen for one
    // connection can never be sent on the next and a folder chosen for one offer
    // can never accept another.
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
                    ActionRow(
                        primary = { m ->
                            Button(
                                onClick = { pickers.chooseFolder(state.linkId, state.promptId) },
                                modifier = m.heightIn(min = 48.dp),
                            ) {
                                Text(stringResource(R.string.files_choose_folder))
                            }
                        },
                        secondary = { m ->
                            OutlinedButton(
                                onClick = viewModel::rejectIncoming,
                                modifier = m.heightIn(min = 48.dp),
                            ) {
                                Text(stringResource(R.string.files_decline))
                            }
                        },
                    )
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
                        // A MINIMUM, not a fixed height: these labels grew ("Cancel and
                        // disconnect", "结束会话并断开连接") and a forced 48.dp clips them at
                        // 320 dp with fontScale 2 — the accessible size is the one that
                        // most needs the room. The 48 dp touch target is preserved as the
                        // floor it always was.
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) {
                        Text(stringResource(cancelLabel(state)))
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
                    onClick = { pickers.chooseFiles(state.linkId) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp),
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
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text(stringResource(cancelLabel(state)))
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
                    modifier = Modifier.heightIn(min = 48.dp),
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
                    ActionRow(
                        primary = { m ->
                            Button(
                                onClick = { viewModel.sendDraft(renderedLink) },
                                enabled = draft.isNotBlank() && !tooLong,
                                modifier = m.heightIn(min = 48.dp),
                            ) {
                                Text(stringResource(R.string.text_send))
                            }
                        },
                        secondary = { m ->
                            TextButton(
                                onClick = viewModel::endText,
                                modifier = m.heightIn(min = 48.dp),
                            ) {
                                Text(
                                    stringResource(
                                        if (state.cancelDisconnects) {
                                            R.string.text_end_legacy
                                        } else {
                                            R.string.text_end
                                        },
                                    ),
                                )
                            }
                        },
                    )
                }

                TextLaneSession.State.INCOMING_REQUEST -> {
                    Text(
                        text = stringResource(R.string.text_incoming_request),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    ActionRow(
                        primary = { m ->
                            Button(
                                onClick = viewModel::acceptText,
                                modifier = m.heightIn(min = 48.dp),
                            ) {
                                Text(stringResource(R.string.text_accept))
                            }
                        },
                        secondary = { m ->
                            OutlinedButton(
                                onClick = viewModel::rejectText,
                                modifier = m.heightIn(min = 48.dp),
                            ) {
                                Text(
                                    stringResource(
                                        if (state.cancelDisconnects) {
                                            R.string.text_decline_legacy
                                        } else {
                                            R.string.text_decline
                                        },
                                    ),
                                )
                            }
                        },
                    )
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
                        // False for the whole life of a legacy conversation:
                        // there is nothing to reopen, so the control is drawn
                        // disabled rather than removed, and the ENDED note
                        // above it says what happened.
                        enabled = state.textCanRequest,
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 48.dp),
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

/**
 * Two actions, side by side when there is room and stacked when there is not.
 *
 * ## Why a Row alone cannot do this
 *
 * A `Row` measures its UNWEIGHTED children at their intrinsic width first and
 * distributes only what is left to the weighted ones. So a long secondary label
 * beside a `weight(1f)` primary does not make the row wrap — it makes the
 * PRIMARY collapse. At 320 dp with fontScale 2 that is exactly what happened:
 * "End conversation and disconnect" fitted and "Send" was not displayed at all,
 * which a check for text overflow alone would have called a pass, because a
 * control squeezed to nothing has nothing to overflow.
 *
 * Both children are weighted here so neither can starve the other, and below a
 * threshold the group stacks instead, because two halves of a narrow screen are
 * not enough for a real label at an accessible text size — a single unbreakable
 * word can exceed them however the text wraps.
 *
 * The threshold scales with the user's text size rather than being a fixed
 * width, so an ordinary phone at ordinary font size keeps exactly the row it
 * had, and only the configurations that actually need the room get the column.
 */
@Composable
private fun ActionRow(
    primary: @Composable (Modifier) -> Unit,
    secondary: @Composable (Modifier) -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val stack = maxWidth < ACTION_ROW_MIN_WIDTH * LocalDensity.current.fontScale
        if (stack) {
            Column(
                Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                primary(Modifier.fillMaxWidth())
                secondary(Modifier.fillMaxWidth())
            }
        } else {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                primary(Modifier.weight(1f))
                secondary(Modifier.weight(1f))
            }
        }
    }
}

/** Below this — scaled by the text size — two actions do not fit side by side. */
private val ACTION_ROW_MIN_WIDTH = 280.dp

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

/**
 * What Cancel actually does on THIS connection.
 *
 * `link/1` retires one batch and keeps the connection; the older wire has no
 * ordered barrier and its sender does not re-read a mid-stream REJECT, so the
 * only cancel that means anything there also ends the connection. Saying
 * "Cancel" for both would make one of them a lie.
 */
private fun cancelLabel(state: TransferController.State): Int =
    if (state.cancelDisconnects) R.string.files_cancel_legacy else R.string.files_cancel
