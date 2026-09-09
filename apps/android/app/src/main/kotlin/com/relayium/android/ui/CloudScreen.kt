package com.relayium.android.ui

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.relayium.android.R
import com.relayium.android.TransferViewModel
import com.relayium.android.account.AccountState
import com.relayium.android.cloud.CloudDownloadModel
import com.relayium.android.cloud.CloudFailure
import com.relayium.android.cloud.CloudHistoryModel
import com.relayium.android.cloud.CloudRetention
import com.relayium.android.cloud.CloudUploadModel

/**
 * The cloud surface: upload files the server holds until someone fetches them,
 * and open a link somebody sent.
 *
 * Two cards rather than two tabs, because they are two halves of one idea and
 * the receive half is usable with no account at all — burying it under a
 * sign-in would hide the thing that needs the least.
 *
 * The link this screen displays contains the KEY. Showing, copying and sharing
 * it is the product: it is how the recipient gets the ability to decrypt, and
 * there is no other channel for it. That is why the copy states plainly that
 * anyone holding it can open the files, and that this device does not keep it.
 */
@Composable
internal fun CloudScreen(
    viewModel: TransferViewModel,
    pickers: CloudPickers,
    onOpenAccount: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(Metrics.section)) {
        ScreenHeader(
            title = stringResource(R.string.cloud_title),
            supporting = stringResource(R.string.cloud_intro),
        )
        SendCard(viewModel, pickers, onOpenAccount)
        ReceiveCard(viewModel, pickers)
        HistoryCard(viewModel)
    }
}

/** The two system pickers this surface needs, registered above the destination
 *  switch for the reason [RelayiumApp] gives: a picker result must outlive a
 *  tab change and an Activity recreation. */
internal class CloudPickers(
    val chooseFiles: () -> Unit,
    val chooseFolder: () -> Unit,
)

// ── sending ─────────────────────────────────────────────────────────────────

@Composable
private fun SendCard(
    viewModel: TransferViewModel,
    pickers: CloudPickers,
    onOpenAccount: () -> Unit,
) {
    val state by viewModel.cloudUpload.state.collectAsStateWithLifecycle()
    val account by viewModel.account.state.collectAsStateWithLifecycle()
    val retention by viewModel.cloudUpload.retention.collectAsStateWithLifecycle()
    val burn by viewModel.cloudUpload.burnAfterRead.collectAsStateWithLifecycle()
    val signedIn = account is AccountState.Ready

    SectionCard {
        run {
            Text(stringResource(R.string.cloud_send_title), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.cloud_send_intro), style = MaterialTheme.typography.bodyMedium)

            if (!signedIn) {
                // Stated as the server's rule, not as a paywall: storing bytes
                // is metered against an account, and receiving never is.
                Text(
                    stringResource(R.string.cloud_needs_account),
                    style = MaterialTheme.typography.bodySmall,
                )
                SecondaryAction(
                    label = stringResource(R.string.cloud_open_account),
                    onClick = onOpenAccount,
                )
                return@run
            }

            when (val current = state) {
                is CloudUploadModel.State.Idle -> ChooseFilesButton(pickers, R.string.cloud_choose_files)

                is CloudUploadModel.State.Selected -> {
                    Text(
                        pluralStringResource(
                            R.plurals.cloud_selected,
                            current.files.size,
                            current.files.size,
                            formatBytes(current.totalBytes),
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    RetentionRow(retention, viewModel.cloudUpload::chooseRetention)
                    Text(
                        stringResource(R.string.cloud_retention_note),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    // What this build actually does about interruption, stated
                    // before the upload rather than discovered after one: only a
                    // selection large enough to be staged can be resumed.
                    Text(
                        stringResource(
                            if (current.totalBytes >= viewModel.cloudUpload.resumableMinBytes) {
                                R.string.cloud_background_note
                            } else {
                                R.string.cloud_small_note
                            },
                        ),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            stringResource(R.string.cloud_burn_label),
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f).padding(end = 12.dp),
                        )
                        Switch(checked = burn, onCheckedChange = viewModel.cloudUpload::chooseBurnAfterRead)
                    }
                    PrimaryAction(
                        label = stringResource(R.string.cloud_upload),
                        onClick = viewModel.cloudUpload::upload,
                    )
                    ChooseFilesButton(pickers, R.string.cloud_change_files, outlined = true)
                }

                is CloudUploadModel.State.Uploading -> {
                    Text(
                        stringResource(
                            R.string.cloud_uploading,
                            formatBytes(current.sent),
                            formatBytes(current.total),
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    SmoothLinearProgress(
                        fraction = if (current.total > 0) {
                            current.sent.toFloat() / current.total.toFloat()
                        } else {
                            0f
                        },
                        operation = current.total,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedButton(
                        onClick = viewModel.cloudUpload::reset,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    ) { Text(stringResource(R.string.cloud_cancel)) }
                }

                is CloudUploadModel.State.Staging -> {
                    Text(
                        stringResource(
                            R.string.cloud_staging,
                            formatBytes(current.staged),
                            formatBytes(current.total),
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    Progress(current.staged, current.total)
                    Text(
                        stringResource(R.string.cloud_staging_note),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    OutlinedButton(
                        onClick = viewModel.cloudUpload::reset,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    ) { Text(stringResource(R.string.cloud_cancel)) }
                }

                is CloudUploadModel.State.Verifying -> Row(
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator()
                    Text(
                        stringResource(R.string.cloud_checking),
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }

                is CloudUploadModel.State.Interrupted -> InterruptedJob(current, viewModel, pickers)

                is CloudUploadModel.State.Uncertain -> UncertainJob(current, viewModel)

                is CloudUploadModel.State.Completing -> {
                    Text(
                        stringResource(R.string.cloud_completing_title),
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Text(
                        stringResource(R.string.cloud_completing_body),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    // No discard here, and that is the point: this job's
                    // directory holds the only copy of the key to an object the
                    // server already has.
                    Button(
                        onClick = viewModel.cloudUpload::resumePending,
                        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
                    ) { Text(stringResource(R.string.cloud_completing_action)) }
                }

                is CloudUploadModel.State.Ready -> ReadyLink(current, viewModel)

                is CloudUploadModel.State.Failed -> {
                    CloudError(current.failure)
                    ChooseFilesButton(pickers, R.string.cloud_choose_files)
                }
            }
            UploadNotice(viewModel)
            StrandedDeviceData(viewModel)
        }
    }
}

/** A determinate bar that never divides by zero and never exceeds full. */
@Composable
private fun Progress(done: Long, total: Long) {
    SmoothLinearProgress(
        fraction = if (total > 0) done.toFloat() / total.toFloat() else 0f,
        // The job's own size: a different one is a different operation, and
        // its bar starts where it actually is rather than easing down.
        operation = total,
        modifier = Modifier.fillMaxWidth(),
    )
}

/**
 * A staged job this account can finish.
 *
 * Resume and Discard, and nothing that happens on its own: recovery is an offer.
 * When the staged bytes are gone the only honest action left is the discard, so
 * that is the only one drawn — the job is still SHOWN, because hiding it would
 * leave data on the device that nothing could name or remove.
 */
@Composable
private fun InterruptedJob(
    state: CloudUploadModel.State.Interrupted,
    viewModel: TransferViewModel,
    pickers: CloudPickers,
) {
    var confirming by rememberSaveable { mutableStateOf(false) }

    Text(stringResource(R.string.cloud_pending_title), style = MaterialTheme.typography.titleSmall)
    Text(
        pluralStringResource(
            R.plurals.cloud_pending_summary,
            state.files,
            state.files,
            formatBytes(state.bytes),
        ),
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
    )
    state.failure?.let { CloudError(it) }
    if (state.resumable) {
        Text(
            stringResource(R.string.cloud_background_note),
            style = MaterialTheme.typography.bodySmall,
        )
        Button(
            onClick = viewModel.cloudUpload::resumePending,
            modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
        ) { Text(stringResource(R.string.cloud_pending_resume)) }
    }
    OutlinedButton(
        onClick = { confirming = true },
        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
    ) { Text(stringResource(R.string.cloud_pending_discard)) }
    if (!state.resumable) ChooseFilesButton(pickers, R.string.cloud_choose_files, outlined = true)

    if (confirming) {
        ConfirmDialog(
            body = R.string.cloud_pending_discard_confirm,
            confirm = R.string.cloud_pending_discard,
            dismiss = R.string.cloud_pending_discard_cancel,
            onConfirm = {
                confirming = false
                viewModel.cloudUpload.discardPending()
            },
            onDismiss = { confirming = false },
        )
    }
}

/**
 * Finalize was requested and its answer never arrived.
 *
 * The one state that must not resolve itself: the object may already exist and
 * be billed, so nothing here starts a fresh upload. The retry re-asks the SAME
 * session, and the copy points at the file list rather than guessing.
 */
@Composable
private fun UncertainJob(state: CloudUploadModel.State.Uncertain, viewModel: TransferViewModel) {
    var confirming by rememberSaveable { mutableStateOf(false) }

    Text(stringResource(R.string.cloud_uncertain_title), style = MaterialTheme.typography.titleSmall)
    Text(
        pluralStringResource(
            R.plurals.cloud_pending_summary,
            state.files,
            state.files,
            formatBytes(state.bytes),
        ),
        style = MaterialTheme.typography.bodyMedium,
    )
    Text(
        stringResource(R.string.cloud_uncertain_body),
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
    )
    Button(
        onClick = viewModel.cloudUpload::resumePending,
        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
    ) { Text(stringResource(R.string.cloud_uncertain_retry)) }
    OutlinedButton(
        onClick = { confirming = true },
        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
    ) { Text(stringResource(R.string.cloud_uncertain_discard)) }

    if (confirming) {
        // NOT the ordinary discard's wording. That one says nothing is
        // published, which is exactly what this state cannot promise: the
        // object may already exist, and removing the local copy would take its
        // only recoverable key with it.
        ConfirmDialog(
            body = R.string.cloud_uncertain_discard_confirm,
            confirm = R.string.cloud_uncertain_discard,
            dismiss = R.string.cloud_pending_discard_cancel,
            onConfirm = {
                confirming = false
                viewModel.cloudUpload.discardPending()
            },
            onDismiss = { confirming = false },
        )
    }
}

/** Something true that is not a failure: the upload worked and the tidy-up did
 *  not, or the link could not be filed for the file list. */
@Composable
private fun UploadNotice(viewModel: TransferViewModel) {
    val notice by viewModel.cloudUpload.notice.collectAsStateWithLifecycle()
    val text = when (notice) {
        CloudUploadModel.Notice.CLEANUP_FAILED -> R.string.cloud_cleanup_failed
        CloudUploadModel.Notice.LINK_KEY_NOT_SAVED -> R.string.cloud_link_key_not_saved
        null -> return
    }
    Text(
        stringResource(text),
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
    )
}

/**
 * Interrupted-upload data this device can no longer read.
 *
 * Its own action, and deliberately not part of signing out or of discarding an
 * account's job: an unreadable record has no readable account, so nothing can
 * say whose bytes these are.
 */
@Composable
private fun StrandedDeviceData(viewModel: TransferViewModel) {
    val stranded by viewModel.cloudUpload.strandedDeviceData.collectAsStateWithLifecycle()
    if (!stranded) return
    Text(stringResource(R.string.cloud_stranded_title), style = MaterialTheme.typography.titleSmall)
    Text(stringResource(R.string.cloud_stranded_body), style = MaterialTheme.typography.bodySmall)
    OutlinedButton(
        onClick = viewModel.cloudUpload::clearStrandedDeviceData,
        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
    ) { Text(stringResource(R.string.cloud_stranded_remove)) }
}

/** One shape for every destructive confirmation on this surface. */
@Composable
private fun ConfirmDialog(
    body: Int,
    confirm: Int,
    dismiss: Int,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        text = { Text(stringResource(body)) },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
            ) { Text(stringResource(confirm)) }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
            ) { Text(stringResource(dismiss)) }
        },
    )
}

@Composable
private fun ChooseFilesButton(pickers: CloudPickers, label: Int, outlined: Boolean = false) {
    val modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp)
    if (outlined) {
        OutlinedButton(onClick = pickers.chooseFiles, modifier = modifier) {
            Text(stringResource(label))
        }
    } else {
        Button(onClick = pickers.chooseFiles, modifier = modifier) { Text(stringResource(label)) }
    }
}

@Composable
private fun RetentionRow(selected: CloudRetention, onSelect: (CloudRetention) -> Unit) {
    Text(stringResource(R.string.cloud_retention_label), style = MaterialTheme.typography.bodyMedium)
    // Wrapped rather than a single row: at 320dp with a doubled font scale five
    // chips do not fit on one line, and a chip pushed off-screen is a retention
    // option the user cannot choose.
    androidx.compose.foundation.layout.FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        for (option in CloudRetention.entries) {
            FilterChip(
                selected = option == selected,
                onClick = { onSelect(option) },
                label = { Text(stringResource(retentionLabel(option))) },
            )
        }
    }
}

private fun retentionLabel(retention: CloudRetention): Int = when (retention) {
    CloudRetention.HOUR -> R.string.cloud_retention_hour
    CloudRetention.DAY -> R.string.cloud_retention_day
    CloudRetention.THREE_DAYS -> R.string.cloud_retention_three_days
    CloudRetention.WEEK -> R.string.cloud_retention_week
    CloudRetention.TWO_WEEKS -> R.string.cloud_retention_two_weeks
}

@Composable
private fun ReadyLink(state: CloudUploadModel.State.Ready, viewModel: TransferViewModel) {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    var copied by rememberSaveable { mutableStateOf(false) }

    Text(stringResource(R.string.cloud_ready_title), style = MaterialTheme.typography.titleSmall)
    // Selectable so the link can be copied by hand as well as by the button.
    SelectionContainer {
        Text(state.link, style = MaterialTheme.typography.bodySmall)
    }
    Text(stringResource(R.string.cloud_ready_note), style = MaterialTheme.typography.bodySmall)
    if (state.burnAfterRead) {
        Text(stringResource(R.string.cloud_ready_burn), style = MaterialTheme.typography.bodySmall)
    }
    if (state.expiresAt > 0) {
        Text(
            stringResource(R.string.cloud_ready_expires, formatDate(state.expiresAt)),
            style = MaterialTheme.typography.bodySmall,
        )
    }
    // The honest statement of what this build does NOT do: the key is not
    // persisted, so a process death loses this link and nothing can recover it.
    Text(stringResource(R.string.cloud_ready_keep), style = MaterialTheme.typography.bodySmall)

    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
            onClick = {
                clipboard.setText(AnnotatedString(state.link))
                copied = true
            },
            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
        ) { Text(stringResource(R.string.cloud_copy)) }
        OutlinedButton(
            onClick = {
                val share = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, state.link)
                }
                context.startActivity(Intent.createChooser(share, null))
            },
            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
        ) { Text(stringResource(R.string.cloud_share)) }
    }
    if (copied) {
        Text(
            stringResource(R.string.cloud_copied),
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
    TextButton(
        onClick = viewModel.cloudUpload::reset,
        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
    ) { Text(stringResource(R.string.cloud_send_another)) }
}

// ── receiving ───────────────────────────────────────────────────────────────

@Composable
private fun ReceiveCard(viewModel: TransferViewModel, pickers: CloudPickers) {
    val state by viewModel.cloudDownload.state.collectAsStateWithLifecycle()
    // NOT `rememberSaveable`: this text is a link that carries the KEY in its
    // fragment, and saved instance state is a durable copy of it. See
    // [com.relayium.android.cloud.CloudLinkDraft].
    val link by viewModel.cloudLinkDraft.text.collectAsStateWithLifecycle()

    SectionCard {
        run {
            Text(stringResource(R.string.cloud_receive_title), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.cloud_receive_intro), style = MaterialTheme.typography.bodyMedium)

            when (val current = state) {
                is CloudDownloadModel.State.Idle, is CloudDownloadModel.State.Failed -> {
                    if (current is CloudDownloadModel.State.Failed) {
                        CloudError(current.failure)
                        if (current.cleanupIncomplete) {
                            Text(
                                stringResource(R.string.cloud_cleanup_incomplete),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                    OutlinedTextField(
                        value = link,
                        onValueChange = viewModel.cloudLinkDraft::set,
                        label = { Text(stringResource(R.string.cloud_link_label)) },
                        colors = accentFieldColors(),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(
                        onClick = { viewModel.cloudDownload.open(link) },
                        enabled = link.isNotBlank(),
                        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
                    ) { Text(stringResource(R.string.cloud_open)) }
                }

                is CloudDownloadModel.State.Loading -> Row(
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator()
                    Text(stringResource(R.string.cloud_loading))
                }

                is CloudDownloadModel.State.Ready -> {
                    Text(
                        pluralStringResource(
                            R.plurals.cloud_contents,
                            current.names.size,
                            current.names.size,
                            formatBytes(current.totalBytes),
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    for (name in current.names) {
                        Text(name, style = MaterialTheme.typography.bodySmall)
                    }
                    if (current.burnAfterRead) {
                        Text(
                            stringResource(R.string.cloud_will_burn),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    if (current.expiresAt > 0) {
                        Text(
                            stringResource(R.string.cloud_expires, formatDate(current.expiresAt)),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    Button(
                        onClick = pickers.chooseFolder,
                        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
                    ) { Text(stringResource(R.string.cloud_choose_folder)) }
                    TextButton(
                        onClick = viewModel.cloudDownload::reset,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    ) { Text(stringResource(R.string.cloud_cancel)) }
                }

                is CloudDownloadModel.State.Saving -> {
                    Text(
                        stringResource(
                            R.string.cloud_saving,
                            formatBytes(current.received),
                            formatBytes(current.total),
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    LinearProgressIndicator(
                        progress = {
                            if (current.total > 0) {
                                (current.received.toFloat() / current.total.toFloat()).coerceIn(0f, 1f)
                            } else {
                                0f
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedButton(
                        onClick = viewModel.cloudDownload::reset,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    ) { Text(stringResource(R.string.cloud_cancel)) }
                }

                is CloudDownloadModel.State.Done -> {
                    Text(
                        pluralStringResource(R.plurals.cloud_saved, current.files, current.files),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    Button(
                        onClick = {
                            viewModel.cloudLinkDraft.clear()
                            viewModel.cloudDownload.reset()
                        },
                        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
                    ) { Text(stringResource(R.string.cloud_open_another)) }
                }
            }
        }
    }
}

// ── the account's stored files ──────────────────────────────────────────────

/**
 * What this account is storing, as the SERVER describes it, plus the links this
 * device can still rebuild.
 *
 * A row with no link is not a missing file. The key never reaches the server, so
 * an object uploaded from another device is real, listed, deletable — and its
 * link simply cannot be reconstructed here. The copy says exactly that rather
 * than implying loss.
 */
@Composable
private fun HistoryCard(viewModel: TransferViewModel) {
    val account by viewModel.account.state.collectAsStateWithLifecycle()
    val state by viewModel.cloudHistory.state.collectAsStateWithLifecycle()
    val deleting by viewModel.cloudHistory.deleting.collectAsStateWithLifecycle()
    val notice by viewModel.cloudHistory.notice.collectAsStateWithLifecycle()
    val signedIn = account is AccountState.Ready

    // One fetch when the surface is first usable. Keyed on the session so a
    // sign-in loads the new account's list and a sign-out does not refetch the
    // old one.
    LaunchedEffect(signedIn) {
        if (signedIn && state is CloudHistoryModel.State.Idle) viewModel.cloudHistory.refresh()
    }

    SectionCard {
        run {
            Text(stringResource(R.string.cloud_history_title), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.cloud_history_intro), style = MaterialTheme.typography.bodyMedium)

            if (!signedIn) {
                Text(
                    stringResource(R.string.cloud_history_signed_out),
                    style = MaterialTheme.typography.bodySmall,
                )
                return@run
            }

            notice?.let {
                Text(
                    stringResource(
                        when (it) {
                            CloudHistoryModel.Notice.DELETED -> R.string.cloud_history_deleted
                            CloudHistoryModel.Notice.ALREADY_GONE -> R.string.cloud_history_delete_gone
                            CloudHistoryModel.Notice.LOCAL_KEY_KEPT -> R.string.cloud_history_local_key_kept
                        },
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }

            when (val current = state) {
                is CloudHistoryModel.State.Idle -> Unit

                is CloudHistoryModel.State.Loading -> Row(
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator()
                    Text(stringResource(R.string.cloud_history_loading))
                }

                is CloudHistoryModel.State.Failed -> CloudError(current.failure)

                is CloudHistoryModel.State.Ready -> {
                    if (current.entries.isEmpty()) {
                        Text(
                            stringResource(R.string.cloud_history_empty),
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        )
                    }
                    for (entry in current.entries) {
                        HorizontalDivider()
                        HistoryRow(entry, deleting == entry.id, viewModel)
                    }
                }
            }

            OutlinedButton(
                onClick = viewModel.cloudHistory::refresh,
                enabled = state !is CloudHistoryModel.State.Loading && deleting == null,
                modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
            ) { Text(stringResource(R.string.cloud_history_refresh)) }
        }
    }
}

@Composable
private fun HistoryRow(
    entry: CloudHistoryModel.Entry,
    deleting: Boolean,
    viewModel: TransferViewModel,
) {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    var confirming by rememberSaveable(entry.id) { mutableStateOf(false) }
    var copied by rememberSaveable(entry.id) { mutableStateOf(false) }
    val expired = remember(entry.expiresAt) {
        entry.expiresAt in 1 until (System.currentTimeMillis() / 1000L)
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
        Text(
            stringResource(
                R.string.cloud_history_size,
                formatBytes(entry.size),
                formatDate(entry.createdAt),
            ),
            style = MaterialTheme.typography.bodyMedium,
        )
        // Rendered from the row's own fields. The server's list does not filter
        // expired rows, so an expired one is shown AS expired rather than
        // assumed absent.
        if (entry.expiresAt > 0) {
            Text(
                if (expired) {
                    stringResource(R.string.cloud_history_expired)
                } else {
                    stringResource(R.string.cloud_history_expires, formatDate(entry.expiresAt))
                },
                style = MaterialTheme.typography.bodySmall,
            )
        }
        if (entry.burnAfterRead) {
            Text(
                stringResource(R.string.cloud_history_burn),
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Text(
            if (entry.downloaded) {
                pluralStringResource(
                    R.plurals.cloud_history_downloads,
                    entry.downloadCount.coerceIn(0, Int.MAX_VALUE.toLong()).toInt(),
                    entry.downloadCount.coerceIn(0, Int.MAX_VALUE.toLong()).toInt(),
                )
            } else {
                stringResource(R.string.cloud_history_not_downloaded)
            },
            style = MaterialTheme.typography.bodySmall,
        )

        val link = entry.link
        if (link == null) {
            Text(
                stringResource(
                    if (entry.keyUnreadable) {
                        R.string.cloud_error_protection_unavailable
                    } else {
                        R.string.cloud_history_no_key
                    },
                ),
                style = MaterialTheme.typography.bodySmall,
            )
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        clipboard.setText(AnnotatedString(link))
                        copied = true
                    },
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                ) { Text(stringResource(R.string.cloud_copy)) }
                OutlinedButton(
                    onClick = {
                        val share = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_TEXT, link)
                        }
                        context.startActivity(Intent.createChooser(share, null))
                    },
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                ) { Text(stringResource(R.string.cloud_share)) }
            }
            if (copied) {
                Text(
                    stringResource(R.string.cloud_copied),
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
        }

        if (deleting) {
            Text(
                stringResource(R.string.cloud_history_deleting),
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        } else {
            TextButton(
                onClick = { confirming = true },
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
            ) { Text(stringResource(R.string.cloud_history_delete)) }
        }
    }

    if (confirming) {
        ConfirmDialog(
            body = R.string.cloud_history_delete_confirm,
            confirm = R.string.cloud_history_delete,
            dismiss = R.string.cloud_history_delete_cancel,
            onConfirm = {
                confirming = false
                viewModel.cloudHistory.delete(entry.id)
            },
            onDismiss = { confirming = false },
        )
    }
}

@Composable
private fun CloudError(failure: CloudFailure) {
    Text(
        stringResource(cloudErrorText(failure)),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
    )
}

/** Every classified failure has copy. Exhaustive on purpose: a new failure kind
 *  must not compile until somebody has written what it says to the user. */
internal fun cloudErrorText(failure: CloudFailure): Int = when (failure.kind) {
    CloudFailure.Kind.NOT_SIGNED_IN -> R.string.cloud_error_not_signed_in
    CloudFailure.Kind.STALE_ACCOUNT -> R.string.cloud_error_stale_account
    CloudFailure.Kind.UNAUTHORIZED -> R.string.cloud_error_unauthorized
    CloudFailure.Kind.RATE_LIMITED -> R.string.cloud_error_rate_limited
    CloudFailure.Kind.DAILY_QUOTA -> R.string.cloud_error_daily_quota
    CloudFailure.Kind.MONTHLY_TRAFFIC -> R.string.cloud_error_monthly_traffic
    CloudFailure.Kind.STORAGE_LIMIT -> R.string.cloud_error_storage_limit
    CloudFailure.Kind.SERVER_FULL -> R.string.cloud_error_server_full
    CloudFailure.Kind.STORAGE_UNAVAILABLE -> R.string.cloud_error_storage_unavailable
    CloudFailure.Kind.REJECTED -> R.string.cloud_error_rejected
    CloudFailure.Kind.SERVER -> R.string.cloud_error_server
    CloudFailure.Kind.NETWORK -> R.string.cloud_error_network
    CloudFailure.Kind.TIMEOUT -> R.string.cloud_error_timeout
    CloudFailure.Kind.MALFORMED -> R.string.cloud_error_malformed
    CloudFailure.Kind.LINK_INVALID -> R.string.cloud_error_link_invalid
    CloudFailure.Kind.NOT_FOUND -> R.string.cloud_error_not_found
    CloudFailure.Kind.DOWNLOAD_LIMITED -> R.string.cloud_error_download_limited
    CloudFailure.Kind.DOWNLOAD_UNAVAILABLE -> R.string.cloud_error_download_unavailable
    CloudFailure.Kind.UNTRUSTED_REDIRECT -> R.string.cloud_error_untrusted_redirect
    CloudFailure.Kind.DAMAGED -> R.string.cloud_error_damaged
    CloudFailure.Kind.UNSAFE_NAME -> R.string.cloud_error_unsafe_name
    CloudFailure.Kind.NAME_COLLISION -> R.string.cloud_error_name_collision
    CloudFailure.Kind.NAME_TAKEN -> R.string.cloud_error_name_taken
    CloudFailure.Kind.NO_SPACE -> R.string.cloud_error_no_space
    CloudFailure.Kind.SAVE_FAILED -> R.string.cloud_error_save_failed
    CloudFailure.Kind.UNREADABLE_SELECTION -> R.string.cloud_error_unreadable_selection
    CloudFailure.Kind.DESTINATION_UNAVAILABLE -> R.string.cloud_error_destination_unavailable
    CloudFailure.Kind.SOURCE_FAILED -> R.string.cloud_error_source_failed
    CloudFailure.Kind.CANCELLED -> R.string.cloud_error_cancelled
    CloudFailure.Kind.UPLOAD_SESSION_GONE -> R.string.cloud_error_upload_session_gone
    CloudFailure.Kind.ALREADY_FINALIZED -> R.string.cloud_error_already_finalized
    CloudFailure.Kind.HISTORY_TOO_LARGE -> R.string.cloud_error_history_too_large
    CloudFailure.Kind.SPOOL_UNUSABLE -> R.string.cloud_error_spool_unusable
    CloudFailure.Kind.PROTECTION_UNAVAILABLE -> R.string.cloud_error_protection_unavailable
    CloudFailure.Kind.STAGE_FAILED -> R.string.cloud_error_stage_failed
    CloudFailure.Kind.NO_PROGRESS -> R.string.cloud_error_no_progress
}
