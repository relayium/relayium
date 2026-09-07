package com.relayium.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.relayium.android.R
import com.relayium.android.TransferController
import com.relayium.android.TransferViewModel
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
