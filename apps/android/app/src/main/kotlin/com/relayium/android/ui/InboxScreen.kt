@file:OptIn(ExperimentalLayoutApi::class)

package com.relayium.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import com.relayium.android.R
import com.relayium.android.inbox.InboxConversation
import com.relayium.android.inbox.InboxConversationEntry
import com.relayium.android.inbox.InboxDeviceRow
import com.relayium.android.inbox.InboxDirectoryState
import com.relayium.android.inbox.InboxKeyHealth
import com.relayium.android.inbox.InboxModel
import com.relayium.android.inbox.InboxReceiving
import com.relayium.android.inbox.InboxSendCoordinator
import com.relayium.android.inbox.InboxSendStatus
import com.relayium.android.inbox.InboxSendTarget
import com.relayium.android.inbox.InboxTargetBlock
import com.relayium.android.inbox.InboxTargetCaveat
import com.relayium.protocol.inbox.InboxAutoAccept
import com.relayium.protocol.inbox.InboxManifestKind

/**
 * The Device Inbox surface: what this device will accept, what it can send to,
 * and what the two have actually exchanged.
 *
 * One vertically-stacked column of cards, hosted inside the app's own scroll
 * exactly like the other three surfaces, so a 320 dp screen at the largest font
 * scale reaches every control by scrolling rather than by an inner viewport that
 * competes with the outer one.
 *
 * Two honesty rules run through the whole file:
 *
 *  * **Nothing claims background delivery.** The policy says what this device
 *    permits; [InboxModel.State.receiving] says what it is doing, and the two
 *    are rendered separately because "auto" while the app is closed receives
 *    nothing at all.
 *  * **No control exists without a behaviour behind it.** Open, export and
 *    share appear only when the host supplied a handler and the entry actually
 *    published files; "send message" appears only for a device that announced it
 *    presents messages. A menu item that did nothing would be worse than its
 *    absence.
 */
@Composable
fun InboxScreen(
    state: InboxModel.State,
    actions: InboxActions,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(20.dp)) {
        val authority = state.authority
        if (authority == null) {
            SignedOutCard(actions)
        } else {
            // KEYED ON THE AUTHORITY, which is the account AND its session
            // generation. Everything below remembers something — a selected
            // device, an open conversation, a draft, a loaded message body — and
            // ids repeat across accounts. Without this key, adopting another
            // account (or the same one again after a sign-out) could leave the
            // previous session's selection and its loaded message on screen.
            //
            // Written as if/else rather than early returns on purpose: a
            // non-local return out of one inline lambda through another produces
            // a synthetic class D8 cannot represent, and the release build fails
            // on it.
            key(authority) {
                if (!state.ready) {
                    InitialCard(state, actions)
                } else {
                    state.failure?.let { FailureCard(it, actions) }
                    ReceivingCard(state, actions)
                    state.keyHealth?.let { KeyHealthCard(it, state.repairing, actions) }
                    if (state.awaitingAnswer.isNotEmpty()) PendingCard(state, actions)
                    DevicesCard(state, actions)
                    if (state.sends.isNotEmpty()) SendsCard(state, actions)
                    HistoryCard(state, actions)
                    StorageNote()
                }
            }
        }
    }
}

/**
 * Everything the surface can ask for.
 *
 * Callbacks rather than a runtime reference, so this screen composes against a
 * value in a test exactly as it does against the live feature — and so the final
 * host adapter is a construction of this class and nothing else.
 *
 * [open], [export] and [share] are NULLABLE on purpose: they need a system
 * integration this component does not own, and a host that has not wired one
 * gets no control rather than a control that does nothing.
 */
class InboxActions(
    val signIn: () -> Unit = {},
    val retry: () -> Unit = {},
    val setPolicy: (InboxAutoAccept) -> Unit = {},
    val respond: (String, Boolean) -> Unit = { _, _ -> },
    val repairKey: () -> Unit = {},
    val chooseFiles: (InboxSendTarget) -> Unit = {},
    val sendText: (InboxSendTarget, String) -> Unit = { _, _ -> },
    val send: (String) -> Unit = {},
    val cancelSend: (String) -> Unit = {},
    val markRead: (Set<String>) -> Unit = {},
    val delete: (Set<String>) -> Unit = {},
    /** A message entry's own text, in either direction, read on demand so it
     *  never lives in saved state. Null means the body is genuinely not here. */
    val loadMessage: suspend (InboxConversationEntry) -> String? = { null },
    val open: ((InboxConversationEntry) -> Unit)? = null,
    val export: ((InboxConversationEntry) -> Unit)? = null,
    val share: ((InboxConversationEntry) -> Unit)? = null,
)

// ── entry states ────────────────────────────────────────────────────────────

@Composable
private fun SignedOutCard(actions: InboxActions) {
    Card {
        Column(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.inbox_title), style = MaterialTheme.typography.titleMedium)
            Text(
                stringResource(R.string.inbox_signed_out_body),
                style = MaterialTheme.typography.bodyMedium,
            )
            Button(
                onClick = actions.signIn,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
            ) { Text(stringResource(R.string.inbox_signed_out_action)) }
        }
    }
}

/** Before the first answer there is nothing to show, so this is the whole
 *  surface — including the failure, because a first load that failed must not
 *  leave a spinner running forever. */
@Composable
private fun InitialCard(state: InboxModel.State, actions: InboxActions) {
    Card {
        Column(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.inbox_title), style = MaterialTheme.typography.titleMedium)
            if (state.failure != null) {
                Text(
                    failureText(state.failure),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
                Button(
                    onClick = actions.retry,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                ) { Text(stringResource(R.string.inbox_retry)) }
            } else {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator()
                    Text(
                        stringResource(R.string.inbox_loading),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }
    }
}

@Composable
private fun FailureCard(failure: InboxModel.State.Failure, actions: InboxActions) {
    Card {
        Column(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                failureText(failure),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
            // A build central refuses, and a credential that is gone, are not
            // fixed by asking again. Offering a retry there would be a button
            // that cannot work.
            if (failure != InboxModel.State.Failure.UNSUPPORTED_BUILD &&
                failure != InboxModel.State.Failure.SIGNED_OUT
            ) {
                OutlinedButton(
                    onClick = actions.retry,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                ) { Text(stringResource(R.string.inbox_retry)) }
            }
        }
    }
}

@Composable
private fun failureText(failure: InboxModel.State.Failure): String = stringResource(
    when (failure) {
        InboxModel.State.Failure.NETWORK -> R.string.inbox_error_network
        InboxModel.State.Failure.SIGNED_OUT -> R.string.inbox_error_signed_out
        InboxModel.State.Failure.STORAGE -> R.string.inbox_error_storage
        InboxModel.State.Failure.LEDGER_FULL -> R.string.inbox_error_ledger_full
        InboxModel.State.Failure.KEY_REPAIR_UNAVAILABLE -> R.string.inbox_error_key_repair
        InboxModel.State.Failure.UNSUPPORTED_BUILD -> R.string.inbox_error_unsupported_build
        InboxModel.State.Failure.PROTOCOL -> R.string.inbox_error_protocol
    },
)

// ── receiving ───────────────────────────────────────────────────────────────

@Composable
private fun ReceivingCard(state: InboxModel.State, actions: InboxActions) {
    Card {
        Column(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                stringResource(R.string.inbox_receive_title),
                style = MaterialTheme.typography.titleMedium,
            )
            state.deviceName?.let {
                Text(
                    stringResource(R.string.inbox_this_device, it),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            // A wrapping row rather than a fixed one: three labelled chips at
            // the largest font scale do not fit across 320 dp.
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (policy in InboxAutoAccept.entries) {
                    FilterChip(
                        selected = state.policy == policy,
                        onClick = { actions.setPolicy(policy) },
                        label = { Text(policyLabel(policy)) },
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    )
                }
            }
            Text(policyHelp(state.policy), style = MaterialTheme.typography.bodyMedium)
            Text(
                receivingText(state.receiving),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
            (state.directory as? InboxDirectoryState.Unavailable)?.let {
                Text(
                    directoryText(it.problem),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            // Stated wherever the policy is chosen, because "auto" reads like a
            // promise this app cannot keep while it is closed.
            Text(
                stringResource(R.string.inbox_foreground_note),
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun policyLabel(policy: InboxAutoAccept): String = stringResource(
    when (policy) {
        InboxAutoAccept.OFF -> R.string.inbox_policy_off
        InboxAutoAccept.ASK -> R.string.inbox_policy_ask
        InboxAutoAccept.AUTO -> R.string.inbox_policy_auto
    },
)

@Composable
private fun policyHelp(policy: InboxAutoAccept): String = stringResource(
    when (policy) {
        InboxAutoAccept.OFF -> R.string.inbox_policy_off_help
        InboxAutoAccept.ASK -> R.string.inbox_policy_ask_help
        InboxAutoAccept.AUTO -> R.string.inbox_policy_auto_help
    },
)

@Composable
private fun receivingText(receiving: InboxReceiving): String = stringResource(
    when (receiving) {
        InboxReceiving.OFF -> R.string.inbox_state_off
        InboxReceiving.STOPPED -> R.string.inbox_state_stopped
        InboxReceiving.LISTENING -> R.string.inbox_state_listening
        InboxReceiving.RECEIVING -> R.string.inbox_state_receiving
        InboxReceiving.UNAVAILABLE -> R.string.inbox_state_unavailable
    },
)

@Composable
private fun directoryText(problem: InboxDirectoryState.Unavailable.Problem): String = stringResource(
    when (problem) {
        InboxDirectoryState.Unavailable.Problem.NOT_A_DIRECTORY -> R.string.inbox_directory_blocked
        InboxDirectoryState.Unavailable.Problem.DISK_FULL -> R.string.inbox_directory_full
        InboxDirectoryState.Unavailable.Problem.PERMISSION_DENIED -> R.string.inbox_directory_denied
    },
)

// ── key health ──────────────────────────────────────────────────────────────

@Composable
private fun KeyHealthCard(
    health: InboxKeyHealth,
    repairing: Boolean,
    actions: InboxActions,
) {
    var confirming by remember { mutableStateOf(false) }
    Card {
        Column(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                stringResource(R.string.inbox_key_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(keyHealthText(health), style = MaterialTheme.typography.bodyMedium)
            // No repair is offered for an ambiguous remote history: choosing one
            // of two active keys would mean this build naming an identity the
            // protocol never named.
            val repairable = health is InboxKeyHealth.NeedsRepair &&
                health.reason != InboxKeyHealth.NeedsRepair.Reason.REMOTE_KEY_AMBIGUOUS
            if (repairing) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                Text(
                    stringResource(R.string.inbox_key_repairing),
                    style = MaterialTheme.typography.bodySmall,
                )
            } else if (repairable) {
                Button(
                    onClick = { confirming = true },
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                ) { Text(stringResource(R.string.inbox_key_repair_action)) }
            }
        }
    }
    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text(stringResource(R.string.inbox_key_repair_confirm_title)) },
            // What it COSTS, stated before it happens: anything already queued
            // to the old key stays sealed to it and cannot be opened here.
            text = { Text(stringResource(R.string.inbox_key_repair_confirm_body)) },
            confirmButton = {
                TextButton(onClick = { confirming = false; actions.repairKey() }) {
                    Text(stringResource(R.string.inbox_key_repair_confirm_action))
                }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) {
                    Text(stringResource(R.string.inbox_cancel))
                }
            },
        )
    }
}

@Composable
private fun keyHealthText(health: InboxKeyHealth): String = when (health) {
    is InboxKeyHealth.Healthy -> stringResource(R.string.inbox_key_healthy)
    is InboxKeyHealth.RepairUnavailable -> stringResource(R.string.inbox_key_unavailable)
    is InboxKeyHealth.NeedsRepair -> stringResource(
        when (health.reason) {
            InboxKeyHealth.NeedsRepair.Reason.REMOTE_KEY_NOT_HELD -> R.string.inbox_key_not_held
            InboxKeyHealth.NeedsRepair.Reason.LOCAL_HISTORY_UNREADABLE -> R.string.inbox_key_unreadable
            InboxKeyHealth.NeedsRepair.Reason.LOCAL_BINDING_DISAGREES -> R.string.inbox_key_disagrees
            InboxKeyHealth.NeedsRepair.Reason.REMOTE_KEY_AMBIGUOUS -> R.string.inbox_key_ambiguous
        },
    )
}

// ── the ask queue ───────────────────────────────────────────────────────────

/** Tasks central is holding for a person on THIS device to answer. Nothing
 *  answers them automatically, which is the whole point of the `ask` policy. */
@Composable
private fun PendingCard(state: InboxModel.State, actions: InboxActions) {
    Card {
        Column(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                stringResource(R.string.inbox_pending_title),
                style = MaterialTheme.typography.titleMedium,
            )
            for (task in state.awaitingAnswer) {
                HorizontalDivider()
                Text(
                    stringResource(
                        R.string.inbox_pending_body,
                        deviceLabel(state, task.sourceDeviceId),
                        bytes(task.ciphertextBytes),
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                )
                val busy = task.id in state.answering
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { actions.respond(task.id, true) },
                        enabled = !busy,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    ) { Text(stringResource(R.string.inbox_pending_accept)) }
                    OutlinedButton(
                        onClick = { actions.respond(task.id, false) },
                        enabled = !busy,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    ) { Text(stringResource(R.string.inbox_pending_decline)) }
                }
            }
        }
    }
}

// ── devices and sending ─────────────────────────────────────────────────────

@Composable
private fun DevicesCard(state: InboxModel.State, actions: InboxActions) {
    // A device id, which is central's own identifier and carries no content —
    // safe across a recreation, unlike anything the user has typed.
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    val selected = state.devices.firstOrNull { it.deviceId == selectedId }

    Card {
        Column(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                stringResource(R.string.inbox_devices_title),
                style = MaterialTheme.typography.titleMedium,
            )
            if (state.devices.isEmpty() && state.blockedDevices.isEmpty()) {
                Text(
                    stringResource(R.string.inbox_devices_empty),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            for (target in state.devices) {
                DeviceRow(target, target.deviceId == selectedId) {
                    selectedId = if (target.deviceId == selectedId) null else target.deviceId
                }
            }
            if (state.blockedDevices.isNotEmpty()) {
                HorizontalDivider()
                Text(
                    stringResource(R.string.inbox_devices_blocked_title),
                    style = MaterialTheme.typography.titleSmall,
                )
                for ((row, block) in state.blockedDevices) {
                    BlockedRow(row, block)
                }
            }
        }
    }
    selected?.let { SendCard(state, it, actions) }
}

@Composable
private fun DeviceRow(target: InboxSendTarget, selected: Boolean, onClick: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        FilterChip(
            selected = selected,
            onClick = onClick,
            label = { Text(target.name) },
            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
        )
        // Caveats are never suppressed: a send that will not land unattended has
        // to say so BEFORE the file is encrypted and uploaded.
        for (caveat in target.availability.caveats) {
            Text(caveatText(caveat), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun caveatText(caveat: InboxTargetCaveat): String = stringResource(
    when (caveat) {
        InboxTargetCaveat.NEEDS_APPROVAL -> R.string.inbox_caveat_approval
        InboxTargetCaveat.DIRECTORY_NOT_READY -> R.string.inbox_caveat_directory
        InboxTargetCaveat.QUEUED_UNTIL_ONLINE -> R.string.inbox_caveat_offline
    },
)

/** Shown with its reason rather than hidden: each block has a different remedy,
 *  and a picker that silently omitted a device leaves the user hunting for it. */
@Composable
private fun BlockedRow(row: InboxDeviceRow, block: InboxTargetBlock) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(row.name, style = MaterialTheme.typography.bodyMedium)
        Text(blockText(block), style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun blockText(block: InboxTargetBlock): String = stringResource(
    when (block) {
        InboxTargetBlock.UNUSABLE_IDENTIFIER -> R.string.inbox_block_identifier
        InboxTargetBlock.NOT_ENROLLED -> R.string.inbox_block_not_enrolled
        InboxTargetBlock.REVOKED -> R.string.inbox_block_revoked
        InboxTargetBlock.CANNOT_RECEIVE -> R.string.inbox_block_cannot_receive
        InboxTargetBlock.UNSUPPORTED_CAPABILITY -> R.string.inbox_block_capability
        InboxTargetBlock.UNSUPPORTED_KEY -> R.string.inbox_block_key
        InboxTargetBlock.RECEIVE_OFF -> R.string.inbox_block_receive_off
    },
)

@Composable
private fun SendCard(state: InboxModel.State, target: InboxSendTarget, actions: InboxActions) {
    // MEMORY ONLY. A draft message is the user's own content, and
    // `rememberSaveable` would put it in a Bundle the system may persist.
    var message by remember(state.authority, target.deviceId) { mutableStateOf("") }

    Card {
        Column(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                stringResource(R.string.inbox_send_to, target.name),
                style = MaterialTheme.typography.titleMedium,
            )
            Button(
                onClick = { actions.chooseFiles(target) },
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
            ) { Text(stringResource(R.string.inbox_send_choose_files)) }

            if (target.deviceId in state.textCapableDevices) {
                OutlinedTextField(
                    value = message,
                    onValueChange = { message = it },
                    label = { Text(stringResource(R.string.inbox_send_message_label)) },
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = { actions.sendText(target, message); message = "" },
                    enabled = message.isNotBlank(),
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                ) { Text(stringResource(R.string.inbox_send_message)) }
            } else {
                Text(
                    stringResource(R.string.inbox_send_no_text),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

// ── outgoing jobs ───────────────────────────────────────────────────────────

/**
 * What is staged or in flight.
 *
 * No percentage anywhere, deliberately: the upload reports none, and a bar this
 * screen invented would be a number about the user's transfer that nothing
 * measured. An indeterminate indicator says "working" and claims nothing else.
 */
@Composable
private fun SendsCard(state: InboxModel.State, actions: InboxActions) {
    Card {
        Column(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                stringResource(R.string.inbox_sending_title),
                style = MaterialTheme.typography.titleMedium,
            )
            for (send in state.sends) {
                HorizontalDivider()
                Text(
                    stringResource(
                        R.string.inbox_sending_to,
                        deviceLabel(state, send.targetDeviceId),
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(sendSummary(send), style = MaterialTheme.typography.bodySmall)
                Text(
                    sendPhaseText(send),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
                if (send.phase == InboxSendStatus.Phase.SENDING) {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }
                // "It did not send" is a claim this app cannot make about an
                // ambiguous outcome. Which unknown it is decides what to say
                // next: an unresolved CREATE is converged by central, so the
                // same request is safe to repeat, while an unresolved single-
                // shot upload has no identity to converge on and a repeat is a
                // separate upload that answers nothing. Telling the user to try
                // again there would be advice that cannot work.
                if (send.uploadUnknown) {
                    Text(
                        stringResource(R.string.inbox_sending_upload_unknown),
                        style = MaterialTheme.typography.bodySmall,
                    )
                } else if (send.ambiguous) {
                    Text(
                        stringResource(R.string.inbox_sending_ambiguous),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (send.phase == InboxSendStatus.Phase.SENDING) {
                        OutlinedButton(
                            onClick = { actions.cancelSend(send.jobId) },
                            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        ) { Text(stringResource(R.string.inbox_sending_cancel)) }
                    } else if (
                        send.phase != InboxSendStatus.Phase.DELIVERED && !send.uploadUnknown
                    ) {
                        Button(
                            onClick = { actions.send(send.jobId) },
                            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        ) { Text(stringResource(R.string.inbox_sending_retry)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun sendSummary(send: InboxSendStatus): String =
    if (send.kind == InboxManifestKind.TEXT) {
        stringResource(R.string.inbox_entry_message, bytes(send.totalBytes))
    } else {
        pluralStringResource(R.plurals.inbox_entry_files, send.names.size, send.names.size) +
            " · " + bytes(send.totalBytes)
    }

@Composable
private fun sendPhaseText(send: InboxSendStatus): String = when (send.phase) {
    InboxSendStatus.Phase.STAGED -> stringResource(R.string.inbox_sending_staged)
    InboxSendStatus.Phase.SENDING -> stringResource(R.string.inbox_sending_active)
    InboxSendStatus.Phase.DELIVERED -> stringResource(R.string.inbox_sending_delivered)
    InboxSendStatus.Phase.STOPPED -> send.stop?.let { stringResource(stopText(it)) }
        ?: stringResource(R.string.inbox_sending_stopped)
}

private fun stopText(reason: InboxSendCoordinator.Result.Reason): Int = when (reason) {
    InboxSendCoordinator.Result.Reason.TARGET_INELIGIBLE -> R.string.inbox_stop_ineligible
    InboxSendCoordinator.Result.Reason.STALE_TARGET_KEY -> R.string.inbox_stop_stale_key
    InboxSendCoordinator.Result.Reason.IDEMPOTENCY_CONFLICT -> R.string.inbox_stop_conflict
    InboxSendCoordinator.Result.Reason.OBJECT_ALREADY_BOUND -> R.string.inbox_stop_bound
    InboxSendCoordinator.Result.Reason.QUEUE_FULL -> R.string.inbox_stop_queue_full
    InboxSendCoordinator.Result.Reason.TRANSPORT -> R.string.inbox_stop_transport
    InboxSendCoordinator.Result.Reason.STORAGE -> R.string.inbox_stop_storage
}

// ── history ─────────────────────────────────────────────────────────────────

@Composable
private fun HistoryCard(state: InboxModel.State, actions: InboxActions) {
    // A peer device id: central's identifier, no content in it.
    var openPeer by rememberSaveable { mutableStateOf<String?>(null) }
    val conversation = state.conversations.firstOrNull { it.peerDeviceId == openPeer }

    Card {
        Column(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                stringResource(R.string.inbox_history_title),
                style = MaterialTheme.typography.titleMedium,
            )
            if (conversation != null) {
                ConversationDetail(state, conversation, actions) { openPeer = null }
            } else {
                if (state.conversations.isEmpty()) {
                    Text(
                        stringResource(R.string.inbox_history_empty),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                for (item in state.conversations) {
                    HorizontalDivider()
                    ConversationRow(state, item) { openPeer = item.peerDeviceId }
                }
            }
        }
    }
}

@Composable
private fun ConversationRow(
    state: InboxModel.State,
    conversation: InboxConversation,
    onOpen: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            deviceLabel(state, conversation.peerDeviceId),
            style = MaterialTheme.typography.bodyLarge,
        )
        if (conversation.unreadCount > 0) {
            Text(
                pluralStringResource(
                    R.plurals.inbox_history_unread,
                    conversation.unreadCount,
                    conversation.unreadCount,
                ),
                style = MaterialTheme.typography.bodySmall,
            )
        }
        OutlinedButton(
            onClick = onOpen,
            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
        ) { Text(stringResource(R.string.inbox_history_open)) }
    }
}

@Composable
private fun ConversationDetail(
    state: InboxModel.State,
    conversation: InboxConversation,
    actions: InboxActions,
    onBack: () -> Unit,
) {
    // Exactly the entries the user was SHOWN, captured when the detail opened.
    // Anything that arrives while it is open was never on screen, and marking it
    // read would hide a delivery nobody saw.
    val observed = remember(conversation.peerDeviceId) {
        conversation.entries.filter { it.isUnread }.map { it.id }.toSet()
    }
    LaunchedEffect(conversation.peerDeviceId) {
        if (observed.isNotEmpty()) actions.markRead(observed)
    }
    var deleting by remember { mutableStateOf<InboxConversationEntry?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            deviceLabel(state, conversation.peerDeviceId),
            style = MaterialTheme.typography.bodyLarge,
        )
        OutlinedButton(
            onClick = onBack,
            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
        ) { Text(stringResource(R.string.inbox_detail_back)) }
        for (entry in conversation.entries) {
            HorizontalDivider()
            EntryRow(state, entry, actions) { deleting = entry }
        }
    }

    deleting?.let { entry ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text(stringResource(R.string.inbox_delete_title)) },
            // Local, and stated as local: this removes a row from THIS device's
            // history. It cancels nothing and clears nobody's inbox.
            text = { Text(stringResource(R.string.inbox_delete_body)) },
            confirmButton = {
                TextButton(onClick = { deleting = null; actions.delete(setOf(entry.id)) }) {
                    Text(stringResource(R.string.inbox_delete_action))
                }
            },
            dismissButton = {
                TextButton(onClick = { deleting = null }) {
                    Text(stringResource(R.string.inbox_cancel))
                }
            },
        )
    }
}

@Composable
private fun EntryRow(
    state: InboxModel.State,
    entry: InboxConversationEntry,
    actions: InboxActions,
    onDelete: () -> Unit,
) {
    Column(
        // Scopes an instrumented assertion to ONE entry. A history screen shows
        // many rows with the same labels and buttons, so a match by text alone
        // finds whichever came first, not the one under test.
        modifier = Modifier.testTag("inboxEntry:${entry.id}"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            stringResource(
                if (entry.direction == InboxConversationEntry.Direction.RECEIVED) {
                    R.string.inbox_entry_received
                } else {
                    R.string.inbox_entry_sent
                },
            ),
            style = MaterialTheme.typography.labelLarge,
        )
        if (entry.kind == InboxConversationEntry.Kind.MESSAGE) {
            MessageBody(state, entry, actions)
        } else {
            Text(
                pluralStringResource(R.plurals.inbox_entry_files, entry.names.size, entry.names.size),
                style = MaterialTheme.typography.bodyMedium,
            )
            // The user's own names, and this is the one place they belong.
            for (name in entry.names) {
                Text(name, style = MaterialTheme.typography.bodySmall)
            }
        }
        Text(bytes(entry.byteCount), style = MaterialTheme.typography.bodySmall)
        entry.sentState?.let {
            Text(sentStateText(it), style = MaterialTheme.typography.bodySmall)
        }

        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // Only for an entry that actually published files, and only when the
            // host wired a handler. Everything else would be a control that
            // cannot act.
            val hasFiles = entry.directory != null &&
                entry.kind == InboxConversationEntry.Kind.FILES
            if (hasFiles) {
                actions.open?.let {
                    OutlinedButton(
                        onClick = { it(entry) },
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    ) { Text(stringResource(R.string.inbox_action_open)) }
                }
                actions.export?.let {
                    OutlinedButton(
                        onClick = { it(entry) },
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    ) { Text(stringResource(R.string.inbox_action_export)) }
                }
                actions.share?.let {
                    OutlinedButton(
                        onClick = { it(entry) },
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    ) { Text(stringResource(R.string.inbox_action_share)) }
                }
            }
            OutlinedButton(
                onClick = onDelete,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
            ) { Text(stringResource(R.string.inbox_delete_action)) }
        }
    }
}

/**
 * A message's own text, read on demand, in either direction.
 *
 * The body is never part of the published state and never reaches saved
 * instance state: it is fetched when the row composes and dropped when it
 * leaves. A sent body comes from the record written when the message was
 * staged, so this device's own history shows what was actually written rather
 * than a byte count.
 *
 * The load is keyed on the AUTHORITY as well as the entry, because a task or
 * job id is unique within an account and not across them: an account switch
 * while a read is in flight must produce a fresh load, not the previous
 * account's message under a repeated id.
 */
@Composable
private fun MessageBody(
    state: InboxModel.State,
    entry: InboxConversationEntry,
    actions: InboxActions,
) {
    // A holder rather than a bare nullable, because "still loading" and "the
    // body is not here" are different facts with different copy — and a screen
    // that showed the first forever would be lying about a message the user
    // deleted.
    val loaded by produceState<LoadedText?>(initialValue = null, state.authority, entry.id) {
        value = null
        value = LoadedText(actions.loadMessage(entry))
    }
    val clipboard = LocalClipboardManager.current
    val body = loaded?.text
    if (loaded == null) {
        Text(
            stringResource(R.string.inbox_entry_message_loading),
            style = MaterialTheme.typography.bodyMedium,
        )
        return
    }
    if (body == null) {
        Text(
            stringResource(R.string.inbox_entry_message_unavailable),
            style = MaterialTheme.typography.bodyMedium,
        )
        return
    }
    SelectionContainer {
        Text(body, style = MaterialTheme.typography.bodyMedium)
    }
    OutlinedButton(
        onClick = { clipboard.setText(AnnotatedString(body)) },
        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
    ) { Text(stringResource(R.string.inbox_action_copy)) }
}

/** One resolved body, so absence is representable. */
private class LoadedText(val text: String?)

@Composable
private fun sentStateText(state: InboxConversationEntry.SentState): String = stringResource(
    when (state) {
        InboxConversationEntry.SentState.STAGED -> R.string.inbox_sent_staged
        InboxConversationEntry.SentState.SENDING -> R.string.inbox_sent_sending
        InboxConversationEntry.SentState.CREATED -> R.string.inbox_sent_created
        InboxConversationEntry.SentState.SAVED -> R.string.inbox_sent_saved
        InboxConversationEntry.SentState.STOPPED -> R.string.inbox_sent_stopped
    },
)

@Composable
private fun StorageNote() {
    Text(
        stringResource(R.string.inbox_storage_note),
        style = MaterialTheme.typography.bodySmall,
    )
}

// ── labels ──────────────────────────────────────────────────────────────────

/**
 * A peer's name when this account can still see the device, and an honest
 * "unknown device" when it cannot.
 *
 * A device removed from the account still has history, and printing its raw id
 * there would be a 32-character string that tells the user nothing.
 */
@Composable
private fun deviceLabel(state: InboxModel.State, deviceId: String): String {
    state.devices.firstOrNull { it.deviceId == deviceId }?.let { return it.name }
    state.blockedDevices.firstOrNull { it.first.id == deviceId }?.let { return it.first.name }
    return stringResource(R.string.inbox_unknown_device)
}

/** Sizes as the rest of the app renders them: a decimal unit the platform's own
 *  file surfaces use, never a fabricated precision. */
@Composable
private fun bytes(count: Long): String = when {
    count >= 1_000_000_000L -> stringResource(R.string.inbox_bytes_gb, "%.1f".format(count / 1e9))
    count >= 1_000_000L -> stringResource(R.string.inbox_bytes_mb, "%.1f".format(count / 1e6))
    count >= 1_000L -> stringResource(R.string.inbox_bytes_kb, "%.1f".format(count / 1e3))
    else -> stringResource(R.string.inbox_bytes, count.toString())
}
