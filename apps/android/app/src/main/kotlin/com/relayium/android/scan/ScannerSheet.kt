package com.relayium.android.scan

import android.app.Activity
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.relayium.android.R

/**
 * The scanner, as a self-contained surface.
 *
 * It owns the viewfinder, the permission request and the four refusals, and it
 * hands back nothing but a prefilled code — which is why it can live outside
 * the app's own UI package and be dropped into whatever screen eventually
 * shows it.
 *
 * ## Everything here is about stopping
 *
 * A camera that stays on behind a dismissed sheet is a privacy failure with a
 * green light on it, so the ways of leaving are all wired:
 *
 *  - the composable leaving the tree disposes and closes;
 *  - the lifecycle going below STARTED closes, because a sheet can stay
 *    composed while the activity stops;
 *  - `bindToLifecycle` stops the capture as well, whatever this file believes.
 *
 * ## The two refusals are two screens
 *
 * A first denial offers to ask again, because asking again works. A permanent
 * denial offers Settings, because asking again does nothing at all and a button
 * that does nothing reads as a broken app. And a device with no camera offers
 * neither — there is nothing to grant. In every one of them the sheet can be
 * dismissed back to the six-digit field, which is the full path and never
 * blocked by this.
 */
@Composable
fun ScannerSheet(
    controller: ScannerController,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val state by controller.state.collectAsStateWithLifecycle()

    // The request the dialog now up belongs to. The dialog is another activity
    // and its answer arrives after it: without carrying the token, an answer
    // that lands after this sheet closed — or after it reopened — would be
    // written as if it were about the question being asked now.
    //
    // **Saveable, not remembered.** The permission dialog is another activity
    // in front of this one, and the system can recreate what is behind it — a
    // rotation while the dialog is up is the ordinary case. A plain `remember`
    // loses the token there, the answer arrives correlated to nothing, and the
    // user's tap is silently discarded with the sheet stuck asking. What is
    // saved is a counter and nothing else: no code, no key, no payload, which
    // is what the rule about saved state is protecting.
    val pendingRequest = rememberSaveable { mutableLongStateOf(0L) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        // `shouldShowRequestPermissionRationale` distinguishes "not now" from
        // "never ask again", and it is only meaningful immediately after the
        // answer — which is here. Reading it later, from a state that has
        // already settled, gives the wrong answer.
        val activity = context.activity()
        val permanent = activity != null && !ActivityCompat.shouldShowRequestPermissionRationale(
            activity,
            ScannerController.CAMERA_PERMISSION,
        )
        controller.onPermissionResult(
            pendingRequest.longValue,
            when {
                granted -> CameraPermission.GRANTED
                permanent -> CameraPermission.DENIED_PERMANENTLY
                else -> CameraPermission.DENIED
            },
        )
        pendingRequest.longValue = 0L
    }

    // Opening the scanner is what asks for the camera. Nothing at launch.
    LaunchedEffect(Unit) { controller.open(context) }
    LaunchedEffect(state) {
        if (state == ScannerState.REQUESTING && pendingRequest.longValue == 0L) {
            pendingRequest.longValue = controller.pendingPermissionRequest()
            permissionLauncher.launch(ScannerController.CAMERA_PERMISSION)
        }
    }

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                // A sheet can outlive the activity's foreground. Stopping is
                // the event that matters; the camera must not be held across
                // it.
                Lifecycle.Event.ON_STOP -> controller.close()
                // And coming BACK has to be wired too. `LaunchedEffect(Unit)`
                // above does not run again, so without this the sheet the user
                // returns to — from the background, or from the settings page a
                // permanent denial sent them to — is an empty rectangle with no
                // camera and no explanation. `resume` re-reads the permission
                // and never prompts, so the return trip from Settings picks up
                // a grant silently and a still-refused one lands on a state
                // with a button rather than on another dialog.
                Lifecycle.Event.ON_START -> {
                    if (pendingRequest.longValue == 0L) controller.resume(context)
                }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            controller.close()
        }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            // **Scrollable, and this is not cosmetic.** At 320dp with the
            // largest font setting the title, the preview, the hint, the manual
            // -entry line and the way out do not fit. Without a scroll the
            // Column simply lays its last children out past the bottom edge,
            // and the control pushed off is Cancel — the one way to leave a
            // screen that is holding the camera open.
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(stringResource(R.string.scan_title), style = MaterialTheme.typography.titleMedium)

        when (state) {
            ScannerState.RUNNING -> Viewfinder(controller)
            ScannerState.IDLE, ScannerState.REQUESTING -> Unit
            ScannerState.DENIED -> Refusal(
                title = stringResource(R.string.scan_denied_title),
                body = stringResource(R.string.scan_denied_body),
                actionLabel = stringResource(R.string.scan_denied_retry),
                onAction = { controller.retry(context) },
            )
            ScannerState.DENIED_PERMANENTLY -> Refusal(
                title = stringResource(R.string.scan_denied_title),
                body = stringResource(R.string.scan_denied_forever_body),
                actionLabel = stringResource(R.string.scan_denied_forever_action),
                onAction = { context.openAppSettings() },
            )
            ScannerState.UNAVAILABLE -> Refusal(
                title = stringResource(R.string.scan_unavailable_title),
                body = stringResource(R.string.scan_unavailable_body),
                actionLabel = null,
                onAction = {},
            )
            ScannerState.FAILED -> Refusal(
                title = stringResource(R.string.scan_failed_title),
                body = stringResource(R.string.scan_failed_body),
                actionLabel = stringResource(R.string.scan_failed_retry),
                onAction = { controller.retry(context) },
            )
        }

        if (state == ScannerState.RUNNING) {
            Text(
                stringResource(R.string.scan_hint),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        // Always present, in every state: the six-digit field behind this sheet
        // is the full path, and the scanner is the shortcut.
        Text(
            stringResource(R.string.scan_manual),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        // `dismiss`, not `onDismiss` alone: this is the one exit that means the
        // user has finished with the scanner, so it is the one that closes an
        // outstanding permission question. Every other way out — a recreation,
        // the lifecycle stopping — keeps it, because a dialog still on screen
        // is still being asked.
        TextButton(
            onClick = {
                controller.dismiss()
                onDismiss()
            },
        ) { Text(stringResource(R.string.scan_cancel)) }
    }
}

@Composable
private fun Viewfinder(controller: ScannerController) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    Box(
        modifier = Modifier
            .fillMaxWidth()
            // Bounded rather than filling, and bounded LOW: the sheet also
            // carries the hint and the way out, and a preview that insists on
            // 180dp is competing with them for a 320dp screen whose text is at
            // double size. A viewfinder can be small and still be aimed; a
            // Cancel button below the fold cannot be pressed.
            .heightIn(min = 120.dp, max = 320.dp),
    ) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { viewContext ->
                PreviewView(viewContext).apply {
                    // The compatible mode renders through a TextureView, which
                    // is what makes the preview correct inside a sheet that can
                    // be animated and clipped.
                    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                }
            },
            update = { view -> controller.bind(context, lifecycleOwner, view.surfaceProvider) },
        )
    }
}

@Composable
private fun Refusal(title: String, body: String, actionLabel: String?, onAction: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        Text(body, style = MaterialTheme.typography.bodyMedium)
        if (actionLabel != null) {
            Button(onClick = onAction) { Text(actionLabel) }
        }
    }
}

/** The Activity behind a composable's context, or null. Needed because the
 *  rationale question is an Activity's to answer. */
private fun android.content.Context.activity(): Activity? {
    var current = this
    while (current is ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}

/** This app's own settings page — the only place a permanent denial can be
 *  undone. Nothing else is passed: the intent names this package and no data. */
private fun android.content.Context.openAppSettings() {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
        .setData(Uri.fromParts("package", packageName, null))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { startActivity(intent) }
}
