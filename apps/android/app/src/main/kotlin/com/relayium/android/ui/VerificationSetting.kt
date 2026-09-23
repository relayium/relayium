package com.relayium.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.relayium.android.R
import com.relayium.android.TransferViewModel

/**
 * The "compare verification codes" preference (A31 a), on the two screens a
 * connection starts from — as on iOS (`VerificationSettingCard`), where it sits
 * on the cross-network and Nearby screens.
 *
 * [locked] while a connection is being made or is up: the controller reads the
 * preference once, when a link becomes ready, so a change mid-link would be a
 * switch that does nothing to the link in front of the user.
 */
@Composable
internal fun VerificationSettingCard(viewModel: TransferViewModel, locked: Boolean) {
    val enabled by viewModel.verification.enabled.collectAsStateWithLifecycle()
    var explained by rememberSaveable { mutableStateOf(false) }

    SectionCard {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .toggleable(
                    value = enabled,
                    enabled = !locked,
                    role = Role.Switch,
                    onValueChange = viewModel::setVerifyPeers,
                ),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.verify_toggle),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f).padding(end = 12.dp),
            )
            // The row carries the semantics and the click; the switch is its
            // picture, so a screen reader hears one control, not two.
            Switch(checked = enabled, onCheckedChange = null, enabled = !locked)
        }
        Text(
            text = stringResource(if (locked) R.string.verify_toggle_locked else R.string.verify_toggle_detail),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (explained) {
            Text(
                text = stringResource(R.string.verify_explain_what),
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                text = stringResource(R.string.verify_explain_encryption),
                style = MaterialTheme.typography.bodySmall,
            )
        } else {
            TertiaryAction(
                label = stringResource(R.string.verify_how_it_works),
                onClick = { explained = true },
            )
        }
    }
}
