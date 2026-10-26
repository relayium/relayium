package com.relayium.android.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.draganddrop.dragAndDropTarget
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draganddrop.DragAndDropEvent
import androidx.compose.ui.draganddrop.DragAndDropTarget
import androidx.compose.ui.draganddrop.mimeTypes
import androidx.compose.ui.draganddrop.toAndroidDragEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.relayium.android.R
import com.relayium.android.ingress.IncomingUri
import com.relayium.android.ingress.IngressIntents
import com.relayium.android.ingress.IngressOutcome
import com.relayium.android.ingress.IngressRequest
import com.relayium.android.ingress.ShareAdmission
import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean

/** Hoisted feedback lets the host retain and present a refused file selection. */
internal enum class SessionFileDropRefusal {
    CONNECTION_CHANGED, UNSUPPORTED, NO_ACTIVITY, NO_GRANT, NO_READ_PERMISSION, SEND_REFUSED,
}

internal class SessionFileDropFeedback {
    var refusal by mutableStateOf<SessionFileDropRefusal?>(null)
        internal set
}

@Composable
internal fun rememberSessionFileDropFeedback() = remember { SessionFileDropFeedback() }

/** System file drags (for example in split screen), plus the ordinary picker. */
@Composable
internal fun SessionFileDrop(
    linkId: Int,
    enabled: Boolean,
    busy: Boolean,
    chooseFiles: () -> Unit,
    dropFiles: (List<Uri>, Int, Closeable) -> Boolean,
    feedback: SessionFileDropFeedback = rememberSessionFileDropFeedback(),
) {
    val context = LocalContext.current
    val activity = remember(context) { context.dropActivity() }
    val authorities = remember(context) { IngressIntents.ownAuthorities(context) }
    val currentLink by rememberUpdatedState(linkId)
    val available by rememberUpdatedState(enabled && !busy)
    val consume by rememberUpdatedState(dropFiles)
    val currentFeedback by rememberUpdatedState(feedback)
    var inside by remember { mutableStateOf(false) }
    val target = remember(activity, authorities) {
        object : DragAndDropTarget {
            private var startLink: Int? = null
            override fun onStarted(event: DragAndDropEvent) {
                startLink = currentLink.takeIf { available }
                currentFeedback.refusal = null
            }
            override fun onEntered(event: DragAndDropEvent) { inside = available }
            override fun onExited(event: DragAndDropEvent) { inside = false }
            override fun onEnded(event: DragAndDropEvent) { inside = false; startLink = null }
            private fun refuse(reason: SessionFileDropRefusal): Boolean {
                currentFeedback.refusal = reason
                return false
            }
            override fun onDrop(event: DragAndDropEvent): Boolean {
                inside = false
                val start = startLink
                // Consume this gesture once, even if a platform dispatch repeats.
                startLink = null
                val native = event.toAndroidDragEvent()
                val clip = native.clipData ?: return false
                if (clip.itemCount !in 1..ShareAdmission.MAX_ITEMS)
                    return refuse(SessionFileDropRefusal.UNSUPPORTED)
                // Plain text is left to its normal destination, without a file error.
                val uris = (0 until clip.itemCount).map { clip.getItemAt(it).uri ?: return false }
                if (start == null || !available || currentLink != start)
                    return refuse(SessionFileDropRefusal.CONNECTION_CHANGED)
                val byKey = uris.associateBy(Uri::toString)
                val result = ShareAdmission.admit(
                    uris.map { IncomingUri(it.toString(), it.scheme, it.authority, it.encodedAuthority) },
                    readGranted = true, // Access still requires a real framework grant below.
                    ownAuthorities = authorities,
                ) as? IngressOutcome.Accepted ?: return refuse(SessionFileDropRefusal.UNSUPPORTED)
                val request = result.request as? IngressRequest.StageFiles
                    ?: return refuse(SessionFileDropRefusal.UNSUPPORTED)
                if (request.share.items.size != byKey.size) return refuse(SessionFileDropRefusal.UNSUPPORTED)
                val receiver = activity ?: return refuse(SessionFileDropRefusal.NO_ACTIVITY)
                val permission = runCatching { receiver.requestDragAndDropPermissions(native) }
                    .getOrNull() ?: return refuse(SessionFileDropRefusal.NO_GRANT)
                val closed = AtomicBoolean(false)
                val lease = Closeable { if (closed.compareAndSet(false, true)) permission.release() }
                val readable = runCatching { uris.all {
                    context.checkUriPermission(it, android.os.Process.myPid(), android.os.Process.myUid(),
                        android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION) ==
                        android.content.pm.PackageManager.PERMISSION_GRANTED
                } }.getOrDefault(false)
                if (!readable) {
                    runCatching { lease.close() }
                    return refuse(SessionFileDropRefusal.NO_READ_PERMISSION)
                }
                return try {
                    val accepted = consume(request.share.items.map { byKey.getValue(it.key) }, start, lease)
                    if (!accepted) {
                        runCatching { lease.close() }
                        refuse(SessionFileDropRefusal.SEND_REFUSED)
                    } else { currentFeedback.refusal = null; true }
                } catch (_: Exception) {
                    runCatching { lease.close() }
                    refuse(SessionFileDropRefusal.SEND_REFUSED)
                }
            }
        }
    }
    val shape = MaterialTheme.shapes.medium
    val highlighted = inside && available
    val color = if (highlighted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline
    Column(
        modifier = Modifier.fillMaxWidth()
            .dragAndDropTarget({ available && it.mimeTypes().isNotEmpty() }, target)
            .border(if (highlighted) 2.dp else 1.dp, color, shape)
            .background(
                if (highlighted) MaterialTheme.colorScheme.primaryContainer
                else MaterialTheme.colorScheme.surfaceContainerLow,
                shape,
            )
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(stringResource(R.string.files_drop_title), style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurface)
        Text(
            stringResource(
                if (highlighted) R.string.files_drop_active
                else if (busy) R.string.files_drop_preparing else R.string.files_drop_hint,
            ),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (feedback.refusal != null) {
            Text(stringResource(R.string.files_drop_rejected),
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium)
        }
        Button(onClick = { feedback.refusal = null; chooseFiles() }, enabled = available,
            modifier = Modifier.heightIn(min = 48.dp)) {
            Text(stringResource(R.string.files_pick))
        }
    }
}

private fun Context.dropActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.takeUnless { it === this }?.dropActivity()
    else -> null
}
