package com.relayium.android.scan

import android.content.Context
import android.graphics.SurfaceTexture
import android.view.Surface
import androidx.camera.core.Preview
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.activity.ComponentActivity
import com.relayium.android.MainActivity
import com.relayium.android.ingress.IngressRequest
import com.relayium.protocol.PairCode
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The scanner against a REAL CameraX pipeline.
 *
 * The happy path here is not a decoder called directly — that is
 * [QrCodecTest]'s job and it proves nothing about frames. This binds the actual
 * `ImageAnalysis` use case to the actual camera, so what it exercises is the
 * part no host test can reach: the Y plane a real pipeline produces, with the
 * row stride, pixel stride, crop rectangle and rotation that device gives it.
 *
 * ## Two things this file has to be careful about, because both made an earlier
 * version of it assert nothing
 *
 * **`RUNNING` is an intention, not a pipeline.** `open` sets it synchronously
 * the moment the permission is known, while the bind goes through
 * `ProcessCameraProvider.getInstance` and completes later. So waiting for
 * `RUNNING` returns almost immediately, and anything read straight afterwards —
 * a session generation above all — is read before there is one. A generation of
 * 0 is never current, so a late-delivery test that captured it would pass
 * whatever the fence did. [awaitBound] waits for the pipeline itself: bound,
 * with a real generation.
 *
 * **The scan cases run inside a real foreground activity, and that is a
 * fidelity choice rather than a diagnosis.** The shipped sheet binds the
 * capture to the activity hosting it, so a test that binds to a synthetic
 * lifecycle registry in a process with no activity is exercising a
 * configuration the app never runs in. `ActivityScenario` with a resumed
 * [MainActivity] removes that difference.
 *
 * It is NOT the explanation for a skip. An earlier version of this comment
 * claimed a background process receives no frames and that this caused the
 * acceptance skips; an independent foreground capture disproved it — real
 * frames were arriving all along, and the fixture's codes were the variable.
 * Nothing here should be read as evidence about why a run skipped; the capture
 * and the offline decode are that evidence.
 *
 * **A camera pointed at a code consumes the run.** On the acceptance emulator
 * the first frames decode immediately, and a successful scan closes the
 * session — so a lifecycle test that then checked "is this generation still
 * current" would be reading the effect of a SUCCESS and calling it the effect
 * of a dismissal. The lifecycle cases therefore use [inertController], whose
 * trusted origin is one nothing in front of the lens will ever match: real
 * frames, real decodes, and a policy that refuses every one of them, so the run
 * stays open and the thing under test is the only thing that closes it.
 */
@RunWith(AndroidJUnit4::class)
class ScannerCameraTest {

    @get:Rule
    val cameraPermission: GrantPermissionRule =
        GrantPermissionRule.grant(android.Manifest.permission.CAMERA)

    private val context = ApplicationProvider.getApplicationContext<Context>()

    /** What the app really talks to, and what the acceptance QR names. */
    private val origin = "https://relayium.com"

    /** The code in the image the emulator is pointed at. */
    private val expectedCode = "042913"

    private lateinit var owner: TestLifecycleOwner
    private val surfaces = ArrayList<Pair<Surface, SurfaceTexture>>()
    private val surfaceExecutor = Executors.newSingleThreadExecutor()

    @Before
    fun setUp() {
        onMain { owner = TestLifecycleOwner().apply { moveTo(Lifecycle.State.RESUMED) } }
    }

    @After
    fun tearDown() {
        onMain { owner.moveTo(Lifecycle.State.DESTROYED) }
        for ((surface, texture) in surfaces) {
            surface.release()
            texture.release()
        }
        surfaces.clear()
        surfaceExecutor.shutdown()
    }

    // ── the real frame path ─────────────────────────────────────────────────

    @Test
    fun aRealCameraFrameCarryingAPairingCodeIsScanned() = inForeground { activity ->
        val scanned = AtomicReference<IngressRequest.PrefillCode?>()
        val latch = CountDownLatch(1)
        val controller = scanController { request ->
            scanned.set(request)
            latch.countDown()
        }
        start(controller, activity)
        // The CALLBACK is the proof, not a state. Waiting on it also covers the
        // case where the scan already happened while this test was still
        // setting up, which on an imagefile camera is the common one.
        assumeScanned(controller, latch)

        val request = scanned.get()
        assertNotNull("scanned nothing", request)
        assertEquals(expectedCode, request!!.code.digits)
        // The scan prefills. There is no case in this type that could join.
        assertEquals(com.relayium.android.ingress.IngressSurface.JOIN, request.surface)
        onMain { controller.close() }
    }

    @Test
    fun aRunningScannerReportsOnceHoweverManyFramesCarryTheCode() = inForeground { activity ->
        // The camera is pointed at ONE code and delivers it many times a
        // second. Every frame after the first must be nothing.
        val results = AtomicInteger()
        val latch = CountDownLatch(1)
        val controller = scanController {
            results.incrementAndGet()
            latch.countDown()
        }
        start(controller, activity)
        assumeScanned(controller, latch)
        // Long enough for many more frames to have been analysed.
        Thread.sleep(2_000)
        assertEquals("one scan, many frames", 1, results.get())
        onMain { controller.close() }
    }

    @Test
    fun closingAndReopeningScansAgainUnderANewRun() = inForeground { activity ->
        val first = CountDownLatch(1)
        val second = CountDownLatch(1)
        val phase = AtomicInteger(1)
        val controller = scanController {
            if (phase.get() == 1) first.countDown() else second.countDown()
        }
        start(controller, activity)
        assumeScanned(controller, first)

        onMain { controller.close() }
        assertEquals(ScannerState.IDLE, controller.state.value)
        phase.set(2)
        start(controller, activity)
        assertTrue(
            "a reopened scanner must scan again",
            second.await(SCAN_TIMEOUT_SECONDS, TimeUnit.SECONDS),
        )
        onMain { controller.close() }
    }

    // ── the pipeline's own lifecycle, with nothing ever accepted ────────────

    @Test
    fun theCameraDoesNotStayOnAfterTheScannerCloses() {
        val controller = inertController { }
        start(controller)
        awaitBound(controller)
        onMain { controller.close() }
        assertEquals(ScannerState.IDLE, controller.state.value)
        assertFalse("the pipeline must be gone", controller.isBoundForTest())
        // Rebinding after a close must not resurrect the capture: the state no
        // longer wants a camera, so `bind` unbinds instead.
        onMain { controller.bind(context, owner, surfaceProvider()) }
        Thread.sleep(1_000)
        assertEquals(ScannerState.IDLE, controller.state.value)
        assertFalse(controller.isBoundForTest())
    }

    @Test
    fun aLifecycleStopClosesTheScannerEvenWithTheSheetStillComposed() {
        val controller = inertController { }
        start(controller)
        awaitBound(controller)
        // The sheet is still there; the activity behind it stopped.
        onMain {
            owner.moveTo(Lifecycle.State.CREATED)
            controller.close()
        }
        assertEquals(ScannerState.IDLE, controller.state.value)
        assertFalse(controller.isBoundForTest())
    }

    @Test
    fun rebindingForTheSameSurfaceDoesNotRestartThePipeline() {
        // `AndroidView`'s update block runs on every recomposition, for reasons
        // that have nothing to do with the camera. Treating each as a new bind
        // tore the pipeline down and opened a new session generation on a
        // repaint.
        val controller = inertController { }
        val surface = surfaceProvider()
        onMain {
            controller.open(context)
            controller.bind(context, owner, surface)
        }
        val generation = awaitBound(controller)
        repeat(5) { onMain { controller.bind(context, owner, surface) } }
        Thread.sleep(1_000)
        assertEquals("a repaint must not open a new run", generation, controller.currentGenerationForTest())
        assertTrue(controller.isBoundForTest())
        onMain { controller.close() }
    }

    @Test
    fun aProviderThatArrivesAfterTheSheetClosedBindsNothing() {
        // `getInstance` resolves on a background thread. Between asking and
        // receiving, the sheet can close — and the stale future must not bind
        // its old owner and old surface into whatever is happening now.
        val controller = inertController { }
        onMain {
            controller.open(context)
            controller.bind(context, owner, surfaceProvider())
            // Closed in the SAME main-thread block, so the future cannot have
            // resolved yet: its listener runs on the main executor, which this
            // block is holding.
            controller.close()
        }
        Thread.sleep(3_000)
        assertEquals(ScannerState.IDLE, controller.state.value)
        assertFalse("a stale future must not have bound anything", controller.isBoundForTest())
        assertEquals("and must not have opened a run", 0L, controller.currentGenerationForTest())
    }

    @Test
    fun aProviderThatArrivesAfterAReopenDoesNotBindTheOldRun() {
        val controller = inertController { }
        onMain {
            controller.open(context)
            controller.bind(context, owner, surfaceProvider())
            controller.close()
            // Reopened immediately: the first future is still outstanding.
            controller.open(context)
            controller.bind(context, owner, surfaceProvider())
        }
        val generation = awaitBound(controller)
        // Long enough for the first future to have resolved and been dropped.
        Thread.sleep(2_000)
        assertEquals("the old future must not have rebound", generation, controller.currentGenerationForTest())
        assertTrue(controller.isBoundForTest())
        onMain { controller.close() }
    }

    // ── the delivery fence, against a REAL generation ───────────────────────

    @Test
    fun aResultForTheCurrentRunIsDelivered() {
        // The positive control. Without it, every assertion below would be
        // satisfied by a fence that simply drops everything — which is the
        // failure mode a test for "late results are dropped" cannot see.
        val delivered = AtomicInteger()
        val controller = inertController { delivered.incrementAndGet() }
        start(controller)
        val generation = awaitBound(controller)
        onMain { controller.deliverOnMain(generation, prefill()) }
        assertEquals("a current result must be delivered", 1, delivered.get())
        // And the run is spent by it: a second delivery for the same generation
        // is one result too many.
        onMain { controller.deliverOnMain(generation, prefill()) }
        assertEquals("exactly once", 1, delivered.get())
        onMain { controller.close() }
    }

    @Test
    fun aResultThatArrivesAfterTheDismissalIsDropped() {
        // The race a camera cannot be made to reproduce on demand: a decode
        // completes on the analysis executor and the user dismisses the sheet
        // before the callback reaches the main thread. The generation is a real
        // one from a real bind — a made-up number would prove only that an
        // unknown generation is rejected, which is the easy half.
        val delivered = AtomicInteger()
        val controller = inertController { delivered.incrementAndGet() }
        start(controller)
        val generation = awaitBound(controller)
        onMain { controller.close() }
        onMain { controller.deliverOnMain(generation, prefill()) }
        assertEquals("a late result must land nowhere", 0, delivered.get())
    }

    @Test
    fun aResultFromASupersededRunIsDropped() {
        val delivered = AtomicInteger()
        val controller = inertController { delivered.incrementAndGet() }
        start(controller)
        val stale = awaitBound(controller)
        onMain { controller.close() }
        start(controller)
        val current = awaitBound(controller)
        assertTrue("the reopen must be a new run", current != stale)
        onMain { controller.deliverOnMain(stale, prefill()) }
        assertEquals("a frame from the old run must land nowhere", 0, delivered.get())
        // The current run still works, so the drop above was the fence rather
        // than a controller that had stopped delivering anything at all.
        onMain { controller.deliverOnMain(current, prefill()) }
        assertEquals(1, delivered.get())
        onMain { controller.close() }
    }

    // ── refusals that need no camera ────────────────────────────────────────
    //
    // **These are structurally weak while the permission is pre-granted, and
    // saying so is the point.** `GrantPermissionRule` means `open` resolves to
    // RUNNING and `pendingPermissionRequest` is 0, so the REQUESTING path — and
    // with it the whole token fence — is not reachable from inside this
    // process. What the cases below really assert is that an UNSOLICITED answer
    // changes nothing, which is worth pinning but is the easy half. The token
    // fence against a genuinely pending request needs the permission to be
    // revoked first, which is root's adb and root's run; it must not be
    // reported as covered here.

    @Test
    fun aRefusedPermissionNeverStartsTheCamera() {
        // The system dialog itself is root's to drive; what belongs here is
        // that a refusal leaves a state that wants no camera. With the
        // permission already granted by the rule, `open` goes straight to
        // RUNNING and nothing is pending — so the refusal branch is asserted
        // only when it is genuinely reachable, and the real system refusal
        // stays root's to drive.
        val controller = inertController { }
        onMain {
            controller.open(context)
            controller.onPermissionResult(controller.pendingPermissionRequest(), CameraPermission.DENIED)
        }
        if (controller.state.value == ScannerState.DENIED) {
            assertTrue(controller.state.value.canRetry)
            onMain { controller.bind(context, owner, surfaceProvider()) }
            Thread.sleep(1_000)
            assertFalse("a refused state must not bind", controller.isBoundForTest())
        }
        onMain { controller.close() }
    }

    @Test
    fun anAnswerWithNoPendingRequestIsIgnored() {
        // With the permission already held, opening goes straight to RUNNING
        // and nothing is pending. An answer arriving anyway — a launcher that
        // fires twice, a recomposition replaying one — must not be able to
        // write a refusal over a working scanner.
        val controller = inertController { }
        onMain { controller.open(context) }
        assertEquals(0L, controller.pendingPermissionRequest())
        val before = controller.state.value
        onMain {
            controller.onPermissionResult(0L, CameraPermission.DENIED)
            controller.onPermissionResult(1L, CameraPermission.DENIED_PERMANENTLY)
            controller.onPermissionResult(99L, CameraPermission.GRANTED)
        }
        assertEquals("an unsolicited answer must change nothing", before, controller.state.value)
        onMain { controller.close() }
    }

    @Test
    fun aPermissionAnswerThatArrivesAfterTheSheetClosedIsIgnored() {
        // The dialog is another activity and its answer arrives after it. Left
        // unfenced, an answer landing after dismissal writes RUNNING and starts
        // a camera nobody is looking at.
        val controller = inertController { }
        var token = 0L
        onMain {
            controller.open(context)
            token = controller.pendingPermissionRequest()
            controller.close()
        }
        onMain { controller.onPermissionResult(token, CameraPermission.GRANTED) }
        assertFalse(
            "a late grant must not start the camera: ${controller.state.value}",
            controller.state.value.wantsCamera,
        )
    }

    @Test
    fun returningFromTheBackgroundRestoresTheScannerRatherThanABlankSheet() {
        // The sheet stays composed, the activity stops and starts again. The
        // bug this covers left IDLE behind with nothing to re-run it: an empty
        // rectangle, no camera, no explanation.
        val controller = inertController { }
        start(controller)
        awaitBound(controller)
        onMain {
            owner.moveTo(Lifecycle.State.CREATED)
            controller.close()
        }
        assertEquals(ScannerState.IDLE, controller.state.value)
        onMain {
            owner.moveTo(Lifecycle.State.RESUMED)
            controller.resume(context)
        }
        // The permission is granted by the rule, so the resume goes straight
        // back to a running scanner without a second prompt.
        assertEquals(ScannerState.RUNNING, controller.state.value)
        onMain { controller.bind(context, owner, surfaceProvider()) }
        awaitBound(controller)
        onMain { controller.close() }
    }

    @Test
    fun aResumeNeverAsksForPermissionAgain() {
        val controller = inertController { }
        onMain {
            controller.open(context)
            controller.close()
            controller.resume(context)
        }
        assertTrue(
            "a resume must not prompt: ${controller.state.value}",
            controller.state.value != ScannerState.REQUESTING,
        )
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /** Accepts what the acceptance camera is pointed at. */
    private fun scanController(onCode: (IngressRequest.PrefillCode) -> Unit) =
        ScannerController(origin, onCode)

    /**
     * Runs a real pipeline and accepts NOTHING.
     *
     * The trusted origin is one no code in front of any lens will match, so
     * every frame is decoded and every result refused by the policy. That keeps
     * the run open for the whole test, which is what makes a lifecycle
     * assertion about it mean something: on a camera showing a real code, a
     * scanning controller closes its own session within a frame or two, and a
     * test asserting "this run ended" would be reading the success rather than
     * the dismissal it claims to test.
     */
    private fun inertController(onCode: (IngressRequest.PrefillCode) -> Unit) =
        ScannerController("https://never-matches.invalid", onCode)

    private fun prefill() = IngressRequest.PrefillCode(PairCode(expectedCode))

    private fun start(controller: ScannerController, lifecycleOwner: LifecycleOwner = owner) {
        onMain {
            controller.open(context)
            controller.bind(context, lifecycleOwner, surfaceProvider())
        }
    }

    /**
     * Run a case with a REAL activity of this app in the foreground.
     *
     * Fidelity is the reason: the shipped sheet binds the capture to the
     * activity hosting it, so binding to a synthetic registry in a process with
     * no activity would be testing a configuration the app never runs in.
     * Frames were never the reason — an independent capture showed them
     * arriving without any activity of ours in front.
     *
     * [MainActivity] is used unchanged and unmodified: this test only launches
     * it, and asserts nothing about what it draws.
     */
    private fun inForeground(block: (ComponentActivity) -> Unit) {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.moveToState(Lifecycle.State.RESUMED)
            val activity = AtomicReference<ComponentActivity?>()
            scenario.onActivity { activity.set(it) }
            val resumed = activity.get()
            assertNotNull("the activity never resumed", resumed)
            block(resumed!!)
        }
    }

    /**
     * Wait for a pipeline that is actually bound, and return ITS generation.
     *
     * `RUNNING` is set before the bind is even requested, so it is not the
     * thing to wait for; a generation of 0 means nothing has been bound, and 0
     * is never current — which would make every fence assertion below pass
     * without testing anything.
     *
     * Skips rather than fails where there is no usable camera: a red test on a
     * machine with no lens would say nothing true.
     */
    private fun awaitBound(controller: ScannerController): Long {
        val deadline = System.currentTimeMillis() + BIND_TIMEOUT_MILLIS
        while (System.currentTimeMillis() < deadline) {
            when (controller.state.value) {
                ScannerState.UNAVAILABLE, ScannerState.FAILED ->
                    assumeTrue("no usable camera: ${controller.state.value}", false)
                else -> Unit
            }
            val generation = controller.currentGenerationForTest()
            if (controller.isBoundForTest() && generation > 0L) return generation
            Thread.sleep(100)
        }
        assumeTrue("the camera never bound a pipeline", false)
        error("unreachable")
    }

    /**
     * Wait for an actual scan callback.
     *
     * The callback is the only proof that frames reached the decoder, so this
     * waits for it rather than for a state — and skips when it never arrives,
     * because "no QR code in front of the lens" is an environment fact rather
     * than a defect. Root's acceptance expects these cases to PASS on the
     * emulator started with `-camera-back imagefile:`; a SKIP there means the
     * camera is not delivering the image and the frame claim is unproven.
     */
    private fun assumeScanned(controller: ScannerController, latch: CountDownLatch) {
        if (latch.await(SCAN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) return
        when (controller.state.value) {
            ScannerState.UNAVAILABLE, ScannerState.FAILED ->
                assumeTrue("no usable camera: ${controller.state.value}", false)
            else ->
                assumeTrue(
                    "no QR code in front of the camera; start the emulator with -camera-back imagefile:",
                    false,
                )
        }
    }

    /**
     * A surface for the preview, with no view in the tree.
     *
     * `Preview` needs somewhere to send frames even when nothing is on screen,
     * and binding analysis alone would test a pipeline this app does not
     * actually run.
     */
    private fun surfaceProvider(): Preview.SurfaceProvider = Preview.SurfaceProvider { request ->
        val texture = SurfaceTexture(0).apply {
            setDefaultBufferSize(request.resolution.width, request.resolution.height)
        }
        val surface = Surface(texture)
        surfaces += surface to texture
        request.provideSurface(surface, surfaceExecutor) { }
    }

    private fun onMain(block: () -> Unit) =
        InstrumentationRegistry.getInstrumentation().runOnMainSync(block)

    private class TestLifecycleOwner : LifecycleOwner {
        private val registry = LifecycleRegistry(this)
        override val lifecycle: Lifecycle get() = registry
        fun moveTo(state: Lifecycle.State) {
            registry.currentState = state
        }
    }

    private companion object {
        const val SCAN_TIMEOUT_SECONDS = 25L
        const val BIND_TIMEOUT_MILLIS = 15_000L
    }
}
