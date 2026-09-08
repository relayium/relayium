package com.relayium.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.relayium.android.R
import com.relayium.android.TransferController
import com.relayium.android.TransferViewModel
import com.relayium.android.nearby.NearbyDevice
import com.relayium.android.nearby.shortPeerId

/**
 * Finding a device on the same network, and choosing one on purpose.
 *
 * The screen's whole job is to make the choice explicit and the state truthful.
 * Nothing here connects on its own, nothing accepts on its own, and every state
 * the underlying room can be in — opening, listed, empty, dropped, unusable —
 * has copy of its own rather than sharing a spinner.
 *
 * ## Why two modes, described differently
 *
 * They are genuinely different products. The local link contacts no server at
 * all; the code-less room is introduced by relayium.com and therefore lists
 * whatever else reaches the internet from the same address. Describing them the
 * same way would be untrue about one of them, so each carries its own sentence
 * and the shared room carries a warning the local one does not need.
 */
@Composable
internal fun NearbyScreen(
    state: TransferController.State,
    viewModel: TransferViewModel,
) {
    val nearby = state.nearby

    Text(
        text = stringResource(R.string.nearby_title),
        style = MaterialTheme.typography.headlineSmall,
    )

    if (!nearby.active) {
        NearbyStartCard(viewModel)
        return
    }

    // One live region for the whole room state, so a screen reader announces a
    // device appearing, a drop and a retry rather than leaving them to be
    // discovered by exploration.
    val statusLabel = stringResource(R.string.cd_nearby_status)
    val status = Modifier
        .fillMaxWidth()
        .semantics {
            contentDescription = statusLabel
            liveRegion = LiveRegionMode.Polite
        }

    // The consent prompt comes FIRST: it is a question about this device, and a
    // question the user has not answered must not sit below a scrolling list.
    nearby.incomingId?.let { peerId ->
        IncomingRequestCard(
            label = deviceLabel(nearby.devices.firstOrNull { it.id == peerId }, peerId),
            onAccept = { viewModel.admitPeer(peerId, nearby.incomingPromptId) },
            onDecline = { viewModel.rejectPeer(peerId, nearby.incomingPromptId) },
        )
    }

    state.errorKey?.let { key ->
        Column(modifier = status) {
            StatusCard(text = stringResource(errorText(key)), isError = true)
        }
    }

    Text(
        text = stringResource(
            if (nearby.direct) R.string.nearby_mode_direct else R.string.nearby_mode_hub,
        ),
        style = MaterialTheme.typography.titleMedium,
    )
    Text(
        text = stringResource(
            if (nearby.direct) {
                R.string.nearby_mode_direct_detail
            } else {
                R.string.nearby_mode_hub_detail
            },
        ),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    if (!nearby.direct) {
        StatusCard(text = stringResource(R.string.nearby_mode_hub_warning), isError = false)
    }

    when {
        // A connection is being built. The list is not offered underneath it:
        // there is exactly one connection, and a second tap would do nothing.
        state.phase == TransferController.Phase.CONNECTING -> Column(
            modifier = status,
            verticalArrangement = Arrangement.spacedBy(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            CircularProgressIndicator()
            Text(
                text = stringResource(
                    R.string.nearby_connecting_to,
                    deviceLabel(
                        nearby.devices.firstOrNull { it.id == nearby.selectedId },
                        nearby.selectedId.orEmpty(),
                    ),
                ),
                style = MaterialTheme.typography.bodyLarge,
            )
            OutlinedButton(
                onClick = viewModel::disconnect,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
            ) {
                Text(stringResource(R.string.files_cancel))
            }
        }

        nearby.room == TransferController.NearbyRoom.CONNECTING -> Row(
            modifier = status,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CircularProgressIndicator(Modifier.height(20.dp).width(20.dp), strokeWidth = 2.dp)
            Text(stringResource(R.string.nearby_searching), style = MaterialTheme.typography.bodyMedium)
        }

        nearby.room == TransferController.NearbyRoom.RECONNECTING -> Column(
            modifier = status,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // The list is EMPTY here by construction: nothing is maintaining it,
            // and leaving devices on screen would claim they are still reachable.
            StatusCard(text = stringResource(R.string.nearby_reconnecting), isError = false)
            Button(
                onClick = viewModel::retryNearby,
                modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
            ) {
                Text(stringResource(R.string.nearby_retry))
            }
        }

        nearby.devices.isEmpty() -> Column(
            modifier = status,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = stringResource(R.string.nearby_empty),
                style = MaterialTheme.typography.bodyMedium,
            )
            if (nearby.direct) {
                Text(
                    text = stringResource(R.string.nearby_empty_direct_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        else -> Column(
            modifier = status,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = stringResource(R.string.nearby_devices_title),
                style = MaterialTheme.typography.titleSmall,
            )
            for (device in nearby.devices) {
                DeviceRow(
                    device = device,
                    onConnect = { viewModel.connectToPeer(device.id, nearby.roomId) },
                )
            }
        }
    }

    HorizontalDivider()

    Text(
        text = stringResource(R.string.nearby_foreground_only),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    OutlinedButton(
        onClick = viewModel::stopNearby,
        modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
    ) {
        Text(stringResource(R.string.nearby_stop))
    }
}

@Composable
private fun NearbyStartCard(viewModel: TransferViewModel) {
    Text(
        text = stringResource(R.string.nearby_intro),
        style = MaterialTheme.typography.bodyLarge,
    )

    if (!viewModel.canStartNearby) {
        // One controller owns one connection, so this is a real constraint
        // rather than a policy. Saying so beats silently ending the transfer the
        // user already has — and the way out is a button that names what it
        // ends, not a start action that quietly does it.
        SwitchAwayCard(
            explanation = stringResource(R.string.nearby_busy),
            action = stringResource(R.string.nearby_busy_end),
            onSwitch = viewModel::endSessionForSwitch,
        )
        return
    }

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = stringResource(R.string.nearby_mode_direct),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = stringResource(R.string.nearby_mode_direct_detail),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(
                onClick = viewModel::startNearbyDirect,
                modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
            ) {
                Text(stringResource(R.string.nearby_start_direct))
            }
        }
    }

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = stringResource(R.string.nearby_mode_hub),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = stringResource(R.string.nearby_mode_hub_detail),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedButton(
                onClick = viewModel::startNearbyHub,
                modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
            ) {
                Text(stringResource(R.string.nearby_start_hub))
            }
        }
    }

    Text(
        text = stringResource(R.string.nearby_foreground_only),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun IncomingRequestCard(label: String, onAccept: () -> Unit, onDecline: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.secondaryContainer,
        ),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = stringResource(R.string.nearby_incoming_title, label),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
            Text(
                text = stringResource(R.string.nearby_incoming_detail),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
            // Stacked, not side by side: at font scale 2 on a 320dp screen two
            // buttons in a row have about 70dp of text width each, and Accept
            // and Decline are the last pair of controls that may be hard to
            // tell apart.
            Button(
                onClick = onAccept,
                modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
            ) {
                Text(stringResource(R.string.nearby_accept))
            }
            OutlinedButton(
                onClick = onDecline,
                modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp),
            ) {
                Text(stringResource(R.string.nearby_decline))
            }
        }
    }
}

@Composable
private fun DeviceRow(device: NearbyDevice, onConnect: () -> Unit) {
    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = deviceLabel(device, device.id),
                style = MaterialTheme.typography.titleSmall,
            )
            if (!device.supportsLink) {
                Text(
                    text = stringResource(R.string.nearby_cannot_link),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            // Full width and stacked under the name rather than beside it: a
            // row would give a long device name and a button the same line, and
            // at font scale 2 one of them loses.
            Button(
                onClick = onConnect,
                modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp),
            ) {
                Text(stringResource(R.string.nearby_connect))
            }
        }
    }
}

/**
 * What a device is CALLED on this screen.
 *
 * Composed here rather than in the model, because the placeholder for a device
 * that announced no usable name is localised copy: resolving it where the list
 * is built would leave a string fixed under whatever locale was current then,
 * and a language change re-renders this but would not re-run that.
 */
@Composable
private fun deviceLabel(device: NearbyDevice?, fallbackId: String): String {
    val unnamed = stringResource(R.string.nearby_unnamed)
    if (device == null) {
        // A peer that is no longer listed — it left while its prompt was up.
        // Named by what is still true about it rather than by a blank.
        return stringResource(R.string.nearby_device_label, unnamed, shortPeerId(fallbackId))
    }
    val name = device.name.ifEmpty { unnamed }
    return if (device.ambiguous || device.name.isEmpty()) {
        stringResource(R.string.nearby_device_label, name, shortPeerId(device.id))
    } else {
        name
    }
}
