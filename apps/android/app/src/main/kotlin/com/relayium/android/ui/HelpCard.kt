package com.relayium.android.ui

import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.core.net.toUri
import com.relayium.android.R

/**
 * The help layer for one destination (A31 b): collapsed by default, one tap to
 * open, and nothing in it that the app does not actually do. See [HelpTopics].
 */
@Composable
internal fun HelpCard(destination: Destination, origin: String) {
    val topic = HelpTopics.topic(destination)
    // Per destination, so opening help on one screen does not open it on all.
    var expanded by rememberSaveable(destination) { mutableStateOf(false) }
    val collapsedLabel = stringResource(R.string.help_collapsed)
    val expandedLabel = stringResource(R.string.help_expanded)
    val context = LocalContext.current
    var noBrowser by rememberSaveable(destination) { mutableStateOf(false) }

    SectionCard {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = Metrics.touch)
                .clickable(role = Role.Button, onClick = { expanded = !expanded })
                .semantics { stateDescription = if (expanded) expandedLabel else collapsedLabel },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.help_title),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.secondary,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = if (expanded) "−" else "+",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.secondary,
            )
        }
        if (!expanded) return@SectionCard

        Text(stringResource(topic.purpose), style = MaterialTheme.typography.bodyMedium)
        HelpSection(R.string.help_steps_heading)
        topic.steps.forEachIndexed { index, step ->
            Text(
                text = "${index + 1}. ${stringResource(step)}",
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        HelpSection(R.string.help_boundary_heading)
        Text(stringResource(topic.boundary), style = MaterialTheme.typography.bodyMedium)
        HelpSection(R.string.help_where_heading)
        Text(stringResource(topic.where), style = MaterialTheme.typography.bodyMedium)
        HelpSection(R.string.help_trouble_heading)
        Text(stringResource(topic.failure), style = MaterialTheme.typography.bodyMedium)
        Text(stringResource(topic.recovery), style = MaterialTheme.typography.bodyMedium)

        topic.guideSlug?.let { slug ->
            val url = HelpTopics.guideUrl(origin, slug, stringResource(R.string.help_guide_language))
            TertiaryAction(
                label = stringResource(R.string.help_open_guide),
                onClick = {
                    noBrowser = runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()))
                    }.isFailure
                },
            )
            if (noBrowser) {
                Text(
                    text = stringResource(R.string.update_no_browser),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
                androidx.compose.foundation.text.selection.SelectionContainer {
                    Text(text = url, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun HelpSection(title: Int) {
    Text(
        text = stringResource(title),
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
