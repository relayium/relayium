package com.relayium.android.scan

import android.content.Context
import android.content.pm.PackageManager
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.UseCase
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.relayium.android.ingress.IngressRequest
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The camera, for as long as a scanner is on screen and not one moment longer.
 *
 * ## Bound to a lifecycle, not to a flag
 *
 * `ProcessCameraProvider.bindToLifecycle` is what makes "off screen means off"
 * structural: the provider stops the capture when the owner stops, whatever
 * this class believes. A hand-rolled permit — start here, stop there — is the
 * shape where one missed path leaves a green light on behind a dialog. This
 * class still unbinds explicitly in [close], because a sheet dismissing is not
 * a lifecycle event on its own.
 *
 * ## Everything asynchronous carries the request it belongs to
 *
 * Three things here complete later than the call that started them, and each
 * one can land in a world that has moved on:
 *
 *  - **The provider future.** `getInstance` resolves on a background thread.
 *    Between asking and receiving, the sheet can close and REOPEN — so a stale
 *    future must not bind its old owner and old surface into the new run. It
 *    carries [bindRequest] and is dropped if that has moved.
 *  - **The rebind.** `AndroidView`'s update block runs on every recomposition,
 *    for reasons that have nothing to do with the camera. Treating each as a
 *    new bind tears down and rebuilds the pipeline — and opens a new session
 *    generation — on a repaint. A bind for the owner and surface already bound
 *    is a no-op.
 *  - **The permission answer.** The dialog is another activity; the answer
 *    arrives after it. If the sheet closed or reopened meanwhile, that answer
 *    is about a question nobody is asking any more, and writing RUNNING from
 *    it would start a camera under a closed sheet.
 *
 * ## The delivery fence
 *
 * A decode happens on the camera executor and the callback has to reach the UI
 * on the main thread; in that gap the user can dismiss. So a result accepted by
 * [ScanSession] is not yet delivered: it is posted to the main thread and the
 * fence is asked AGAIN there. Consuming a run authorises one result; it does
 * not authorise delivering it whenever it happens to arrive.
 *
 * ## What it never does
 *
 * It never joins. The only thing it can emit is an
 * [IngressRequest.PrefillCode] — a type with no case that could start a
 * connection — and it reaches the caller through the same
 * [com.relayium.android.ingress.ScanPolicy] a tapped link crosses.
 */
class ScannerController(
    private val trustedOrigin: String,
    /** Where an accepted code goes, on the MAIN thread, already fenced. */
    private val onCode: (IngressRequest.PrefillCode) -> Unit,
) {

    private val session = ScanSession()
    private val _state = MutableStateFlow(ScannerState.IDLE)
    val state: StateFlow<ScannerState> = _state.asStateFlow()

    private var provider: ProcessCameraProvider? = null
    private var boundUseCases: List<UseCase> = emptyList()
    private var analysisExecutor: ExecutorService? = null
    /** The run the CURRENTLY bound pipeline belongs to. */
    private var boundGeneration = 0L

    /**
     * Identity of the most recent INTENT to bind.
     *
     * Bumped by every bind, unbind and close, so anything that completes later
     * can ask whether it is still the thing that was asked for.
     */
    private var bindRequest = 0L

    /** What is bound right now, so a repeat bind for the same pair is a no-op. */
    private var boundOwner: LifecycleOwner? = null
    private var boundSurface: Preview.SurfaceProvider? = null

    /**
     * Identity of the outstanding permission request, or 0.
     *
     * The caller receives it when the state enters [ScannerState.REQUESTING]
     * and gives it back with the answer, which is what lets a stale answer be
     * recognised as one.
     */
    private var permissionRequest = 0L

    /**
     * Whether this scanner has already put the system dialog up once.
     *
     * Survives [close], because the thing it protects against is the sheet
     * being disposed and composed again — a rotation, a configuration change,
     * a recomposition after process-level recreation. Only [retry], which is a
     * button the user presses, arms another prompt.
     */
    private var asked = false

    /**
     * A system dialog this controller raised is still unanswered.
     *
     * ## Why this has to survive the composable leaving the tree
     *
     * The permission dialog is another Activity in front of this one, and the
     * system is free to RECREATE what is behind it — a rotation, a theme
     * change, a locale switch while the dialog is up. That disposes the sheet
     * and composes a new one, all while the question is still on screen and
     * still unanswered.
     *
     * Treating that disposal as "the question is closed" is what broke the
     * journey: [close] invalidated the outstanding request, the restored answer
     * token no longer matched, the user's Grant was DISCARDED, and the scanner
     * sat on a refusal screen having just been given the camera. The
     * re-composed sheet could not fix it either — it must not prompt again, so
     * there was nothing left to produce an answer.
     *
     * The controller outlives the composition (it belongs to the ViewModel), so
     * the request it raised outlives a detach too. What must NOT survive is a
     * genuine dismissal — see [dismiss].
     */
    private var awaitingAnswer = false

    // ── what the surface asks for ───────────────────────────────────────────

    /**
     * The user opened the scanner.
     *
     * This is the ONLY thing that leads to a permission request. Asking at
     * launch would be a prompt for a feature nobody has touched, and it teaches
     * people to deny the one that matters later.
     */
    fun open(context: Context) {
        // A question that is already on screen is not asked again, and is not
        // answered here. This is the re-composition behind an outstanding
        // dialog: the sheet was disposed and rebuilt while the system was still
        // waiting for the user, and recomputing from scratch would land on a
        // refusal — `alreadyAsked` — for a request that has not been refused.
        //
        // Bounded by what is actually true right now: a permission that was
        // granted while this was detached, or a device with no camera, falls
        // through to the ordinary decision below.
        if (awaitingAnswer && hasCamera(context) && !isGranted(context)) {
            _state.value = ScannerState.REQUESTING
            return
        }
        _state.value = ScannerTransitions.opened(
            hasCamera = hasCamera(context),
            alreadyGranted = isGranted(context),
            alreadyAsked = asked,
        )
        if (_state.value == ScannerState.REQUESTING) {
            asked = true
            permissionRequest += 1
            awaitingAnswer = true
        }
    }

    /**
     * The surface became visible again after a stop — a return from the
     * background, or from the settings page a permanent denial sent the user
     * to.
     *
     * Separate from [open] because it must NOT prompt: see
     * [ScannerTransitions.resumed]. A permission granted while the app was away
     * is picked up here silently, which is exactly the trip back from Settings.
     */
    fun resume(context: Context) {
        _state.value = ScannerTransitions.resumed(
            current = _state.value,
            hasCamera = hasCamera(context),
            granted = isGranted(context),
        )
    }

    /** The token to give back with the answer, or 0 when nothing was asked. */
    fun pendingPermissionRequest(): Long =
        if (_state.value == ScannerState.REQUESTING) permissionRequest else 0L

    /**
     * The system answered.
     *
     * [CameraPermission] is decided by the caller, which is the only place
     * `shouldShowRequestPermissionRationale` is meaningful. [request] is the
     * token from [pendingPermissionRequest]: an answer to a question that has
     * since been closed, superseded by a newer open, or answered already is
     * dropped rather than written — otherwise a dialog dismissed after the
     * sheet closed would set RUNNING and start a camera nobody is looking at.
     */
    fun onPermissionResult(request: Long, permission: CameraPermission) {
        if (request == 0L || request != permissionRequest) return
        if (_state.value != ScannerState.REQUESTING) return
        // Spent: a second answer for the same request cannot re-enter.
        permissionRequest += 1
        awaitingAnswer = false
        _state.value = ScannerTransitions.answered(permission)
    }

    /**
     * The user ended the scanner.
     *
     * The one thing that closes an outstanding question. A late answer to it
     * afterwards is about something nobody is asking any more, so it is refused
     * — a scanner the user dismissed must never come back holding the camera
     * because a dialog they had already walked away from was finally answered.
     *
     * Distinct from [close], which stops the camera without deciding whether
     * the question is over: see there for why the two cannot be the same call.
     */
    fun dismiss() {
        awaitingAnswer = false
        permissionRequest += 1
        close()
    }

    /**
     * The user asked to try again after a refusal or a binding failure.
     *
     * This is the only thing that re-arms the prompt, and it is a button press
     * — which is the difference between asking again because somebody asked
     * and asking again because the screen rotated.
     */
    fun retry(context: Context) {
        _state.value = ScannerTransitions.retried(_state.value, hasCamera(context))
        if (_state.value == ScannerState.REQUESTING) {
            asked = true
            permissionRequest += 1
            awaitingAnswer = true
        }
    }

    /**
     * The scanner is no longer on screen: stop the capture and end the run.
     *
     * Called from dismissal AND from the lifecycle's own stop. Both are real —
     * a sheet can be dismissed while the activity stays resumed, and an
     * activity can stop with the sheet still composed — and neither implies the
     * other.
     */
    fun close() {
        session.close()
        unbind()
        // An outstanding question is NOT closed by this.
        //
        // `close` is called from two things that mean different things: the
        // composable leaving the tree, and the lifecycle stopping. Neither can
        // tell a user walking away from a recreation behind the system dialog —
        // and invalidating the request on the second one discards the answer to
        // a question still on screen. Only [dismiss] ends the question, because
        // only the user ending the scanner does.
        //
        // The camera is stopped either way: that is what this call is for, and
        // it does not depend on the distinction.
        if (!awaitingAnswer) permissionRequest += 1
        _state.value = if (awaitingAnswer) {
            // Still the same question. Collapsing to IDLE here is what made the
            // re-composed sheet ask `opened` from scratch.
            ScannerState.REQUESTING
        } else {
            ScannerTransitions.stopped(_state.value)
        }
    }

    // ── the camera ──────────────────────────────────────────────────────────

    /**
     * Bind preview and analysis for the current state, or unbind if the state
     * does not want a camera.
     *
     * Safe to call repeatedly with the same arguments, which the caller does:
     * `AndroidView`'s update block runs on every recomposition. A rebind for a
     * pair that is already bound returns without touching the pipeline, so a
     * repaint cannot restart the camera or open a new session generation.
     */
    fun bind(context: Context, owner: LifecycleOwner, surfaceProvider: Preview.SurfaceProvider) {
        if (!_state.value.wantsCamera) {
            unbind()
            return
        }
        if (provider != null && boundOwner === owner && boundSurface === surfaceProvider) return

        val request = ++bindRequest
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            // Everything that could have changed while the future resolved: the
            // sheet closing, reopening with a different owner and surface, or
            // the state moving away from wanting a camera at all.
            if (request != bindRequest) return@addListener
            if (!_state.value.wantsCamera) return@addListener
            val cameraProvider = try {
                future.get()
            } catch (_: Exception) {
                // Interrupted, or the provider failed to initialise. There is no
                // camera to show, and retrying is worth offering.
                failBind(null)
                return@addListener
            }
            if (request != bindRequest) return@addListener
            startCapture(request, cameraProvider, owner, surfaceProvider)
        }, ContextCompat.getMainExecutor(context))
    }

    private fun startCapture(
        request: Long,
        cameraProvider: ProcessCameraProvider,
        owner: LifecycleOwner,
        surfaceProvider: Preview.SurfaceProvider,
    ) {
        // Everything previously bound, gone before anything new is bound:
        // rebinding on top of a live analysis is how two analyzers end up
        // decoding into two generations at once. It bumps `bindRequest`, so the
        // identity for THIS bind is restored immediately afterwards.
        unbind()
        bindRequest = request

        val generation = session.open()
        val executor = Executors.newSingleThreadExecutor()
        val analysis = ImageAnalysis.Builder()
            // The newest frame, and drop the rest. A queue would hand the
            // decoder a picture of where the phone USED to be pointing, and the
            // backlog grows for as long as decoding is slower than the sensor.
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        analysis.setAnalyzer(
            executor,
            QrAnalyzer(session, generation, trustedOrigin) { produced, accepted ->
                deliver(produced, accepted)
            },
        )
        val preview = Preview.Builder().build().apply { setSurfaceProvider(surfaceProvider) }
        val useCases = listOf(preview, analysis)
        val selector = selectorFor(cameraProvider)
        if (selector == null) {
            // `FEATURE_CAMERA_ANY` said there is a camera and the provider has
            // no lens this can bind. A front-only device used to reach the
            // BINDING FAILURE path here and be offered "try again" forever, for
            // a condition that will never change. The honest answer is that
            // there is no camera to scan with.
            executor.shutdown()
            session.close()
            _state.value = ScannerState.UNAVAILABLE
            return
        }
        try {
            cameraProvider.bindToLifecycle(owner, selector, preview, analysis)
        } catch (_: Exception) {
            // `IllegalArgumentException` when no camera matches the selector,
            // `IllegalStateException` from the provider. A device that reports a
            // camera and refuses to bind one is real, and often transient —
            // another app is holding it.
            //
            // The cleanup matters as much as the state: a partial bind can have
            // taken hold before the throw, and the session generation is
            // already open, so leaving either behind means a frame from a
            // failed start arriving into a run the user never saw begin.
            executor.shutdown()
            failBind(Cleanup(cameraProvider, useCases))
            return
        }
        provider = cameraProvider
        boundUseCases = useCases
        analysisExecutor = executor
        boundOwner = owner
        boundSurface = surfaceProvider
        boundGeneration = generation
    }

    /**
     * Back camera if there is one, front camera if that is all there is.
     *
     * **The fallback is deliberate, not a convenience.** `FEATURE_CAMERA_ANY`
     * is what [hasCamera] can ask before a provider exists, and it is true on a
     * device whose only lens faces the user — a tablet, a kiosk. Binding a
     * back-camera selector there fails, and a failure is the wrong word for a
     * device that can scan perfectly well by being turned around.
     *
     * Mirroring is not a problem: CameraX mirrors the front PREVIEW for
     * display, while `ImageAnalysis` delivers sensor frames, so what the
     * decoder sees is not flipped and a QR code reads normally.
     *
     * `hasCamera` can throw while the provider initialises, and a throw here
     * means "cannot say", which is not the same as "no".
     */
    private fun selectorFor(cameraProvider: ProcessCameraProvider): CameraSelector? {
        for (candidate in listOf(CameraSelector.DEFAULT_BACK_CAMERA, CameraSelector.DEFAULT_FRONT_CAMERA)) {
            if (runCatching { cameraProvider.hasCamera(candidate) }.getOrDefault(false)) return candidate
        }
        return null
    }

    /** A partially bound pipeline that still has to be taken down. */
    private class Cleanup(val provider: ProcessCameraProvider, val useCases: List<UseCase>)

    private fun failBind(cleanup: Cleanup?) {
        // The generation dies with the attempt. Without this, `session.isOpen`
        // stays true and a frame that slipped through a partial bind would be
        // decoded into a run that failed to start.
        session.close()
        cleanup?.let { partial ->
            // Only THIS attempt's use cases, never `unbindAll`: another part of
            // the app may hold the camera for its own reasons, and a failure
            // here is not authority to stop it.
            runCatching { partial.provider.unbind(*partial.useCases.toTypedArray()) }
        }
        _state.value = ScannerTransitions.bindFailed()
    }

    private fun unbind() {
        // Bumped first: anything still in flight is now stale, whatever order
        // the rest of this runs in.
        bindRequest += 1
        val held = provider
        val cases = boundUseCases
        provider = null
        boundUseCases = emptyList()
        boundOwner = null
        boundSurface = null
        if (held != null && cases.isNotEmpty()) {
            runCatching { held.unbind(*cases.toTypedArray()) }
        }
        // After the unbind, so a frame already queued still has a live executor
        // to be dropped on rather than a rejected execution.
        analysisExecutor?.shutdown()
        analysisExecutor = null
    }

    private fun deliver(generation: Long, request: IngressRequest.PrefillCode) {
        mainPost { deliverOnMain(generation, request) }
    }

    /**
     * The fence, asked on the thread where the answer is true.
     *
     * Internal rather than private so an instrumentation test can drive the
     * late-callback case directly: the race it covers — a dismissal landing
     * between the decode and the delivery — cannot be produced reliably by
     * pointing a camera at something.
     */
    internal fun deliverOnMain(generation: Long, request: IngressRequest.PrefillCode) {
        if (!session.isCurrent(generation)) return
        // Ended here, before the callback: the run has produced the one result
        // it is going to, and the surface is about to close over it.
        session.close()
        onCode(request)
    }

    /**
     * The run the currently bound pipeline belongs to.
     *
     * Internal, and only for the instrumentation that drives the delivery
     * fence: that test needs a REAL generation from a REAL bind, because a
     * made-up number would prove only that an unknown generation is rejected —
     * which is the easy half. The interesting case is the generation that WAS
     * valid a moment ago.
     */
    internal fun currentGenerationForTest(): Long = boundGeneration

    /** Whether a pipeline is bound right now. Internal, for the rebind
     *  idempotence case, which is otherwise invisible from outside. */
    internal fun isBoundForTest(): Boolean = provider != null

    /** Posting, as a seam. A test drives [deliverOnMain] directly. */
    private fun mainPost(block: () -> Unit) {
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            block()
        } else {
            android.os.Handler(android.os.Looper.getMainLooper()).post(block)
        }
    }

    // ── device facts ────────────────────────────────────────────────────────

    private fun hasCamera(context: Context): Boolean =
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

    private fun isGranted(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, CAMERA_PERMISSION) ==
            PackageManager.PERMISSION_GRANTED

    companion object {
        /**
         * Named here rather than reached through a generated constant so the
         * one permission this feature uses is visible in the class that uses
         * it. The manifest declaration is its own, separate change.
         */
        const val CAMERA_PERMISSION = android.Manifest.permission.CAMERA
    }
}
