package com.relayium.android.integration

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.relayium.android.ingress.IngressRequest
import com.relayium.android.scan.CameraPermission
import com.relayium.android.scan.ScannerController
import com.relayium.android.scan.ScannerState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The permission question survives the Activity being rebuilt behind it.
 *
 * ## The journey these cases are about
 *
 * The system permission dialog is another Activity in front of this one, and
 * the system may recreate what is behind it — a rotation while the dialog is
 * up is the ordinary case. That disposes the scanner sheet and composes a new
 * one, both while the question is still on screen and still unanswered.
 *
 * A device run proved what happened next: the disposal invalidated the
 * outstanding request, the restored answer token no longer matched, the user's
 * **Grant was discarded**, and the scanner sat on a refusal screen twenty
 * seconds after Android had granted the camera. The re-composed sheet could not
 * recover it either — it must not prompt a second time, so nothing was left to
 * produce an answer.
 *
 * These drive the real [ScannerController] against the real package manager.
 *
 * ## Why this requires the permission to be REVOKED
 *
 * With CAMERA already granted, `open` goes straight to `RUNNING` and there is
 * no question to lose — the case would pass while testing nothing. So it is
 * asserted rather than skipped: a run that cannot exercise the journey says so
 * instead of reporting a pass. The owning harness revokes the permission first.
 */
@RunWith(AndroidJUnit4::class)
class ScannerPermissionIdentityTest {

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun controller(onCode: (IngressRequest.PrefillCode) -> Unit = {}) =
        ScannerController(trustedOrigin = "https://relayium.com", onCode = onCode)

    @Before
    fun requireCameraRevoked() {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        assertTrue(
            "this case needs CAMERA revoked — granted, `open` goes straight to RUNNING and the " +
                "outstanding-question journey cannot happen at all. Revoke it before the run.",
            !granted,
        )
    }

    @Test
    fun aRecreationBehindTheDialogKeepsTheQuestionAndItsIdentity() {
        val controller = controller()
        controller.open(context)
        assertEquals(ScannerState.REQUESTING, controller.state.value)
        val token = controller.pendingPermissionRequest()
        assertNotEquals("a raised question must have a token", 0L, token)

        // The sheet is disposed and the lifecycle stops — what a recreation
        // behind the dialog actually delivers.
        controller.close()
        // Still the same question: collapsing to IDLE here is what made the new
        // composition ask from scratch and land on a refusal.
        assertEquals(ScannerState.REQUESTING, controller.state.value)

        // The new composition opens the sheet again. It must NOT prompt a second
        // time, and must not decide the question itself.
        controller.open(context)
        assertEquals(ScannerState.REQUESTING, controller.state.value)
        assertEquals(
            "the identity of the outstanding question changed across the recreation, so the "
                + "answer already on screen would be discarded",
            token,
            controller.pendingPermissionRequest(),
        )
    }

    @Test
    fun theGrantGivenAfterARecreationIsApplied() {
        val controller = controller()
        controller.open(context)
        val token = controller.pendingPermissionRequest()
        controller.close()
        controller.open(context)

        // The user taps Grant on the dialog that was there the whole time.
        controller.onPermissionResult(token, CameraPermission.GRANTED)
        assertEquals(
            "the grant was discarded, which is the reported defect: camera granted, scanner "
                + "showing a refusal",
            ScannerState.RUNNING,
            controller.state.value,
        )
    }

    @Test
    fun theAnswerIsStillSpentExactlyOnce() {
        val controller = controller()
        controller.open(context)
        val token = controller.pendingPermissionRequest()
        controller.onPermissionResult(token, CameraPermission.GRANTED)
        assertEquals(ScannerState.RUNNING, controller.state.value)

        // A second delivery of the same answer cannot re-enter.
        controller.onPermissionResult(token, CameraPermission.DENIED)
        assertEquals(ScannerState.RUNNING, controller.state.value)
    }

    @Test
    fun dismissingEndsTheQuestionSoALateGrantCannotRevive() {
        val controller = controller()
        controller.open(context)
        val token = controller.pendingPermissionRequest()

        // The user finished with the scanner — Cancel, a swipe, or the scrim.
        controller.dismiss()
        assertNotEquals(ScannerState.RUNNING, controller.state.value)

        // The dialog they walked away from is answered afterwards. A scanner
        // the user closed must never come back holding the camera.
        controller.onPermissionResult(token, CameraPermission.GRANTED)
        assertNotEquals(
            "a dismissed scanner was reactivated by a late grant",
            ScannerState.RUNNING,
            controller.state.value,
        )
    }

    @Test
    fun aRefusalStillEndsTheQuestion() {
        val controller = controller()
        controller.open(context)
        val token = controller.pendingPermissionRequest()
        controller.onPermissionResult(token, CameraPermission.DENIED)
        assertEquals(ScannerState.DENIED, controller.state.value)

        // Nothing is outstanding any more, so an ordinary close collapses as it
        // always did rather than preserving a question that was answered.
        controller.close()
        assertEquals(ScannerState.IDLE, controller.state.value)
    }

    @Test
    fun aPermanentRefusalSurvivesAClose() {
        val controller = controller()
        controller.open(context)
        val token = controller.pendingPermissionRequest()
        controller.onPermissionResult(token, CameraPermission.DENIED_PERMANENTLY)
        assertEquals(ScannerState.DENIED_PERMANENTLY, controller.state.value)
        controller.close()
        // Still permanent when the user comes back: re-asking is what the
        // system will not do, and offering it would be a button that does
        // nothing.
        assertEquals(ScannerState.DENIED_PERMANENTLY, controller.state.value)
    }
}
