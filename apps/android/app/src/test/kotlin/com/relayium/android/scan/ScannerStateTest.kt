package com.relayium.android.scan

import com.relayium.protocol.PairCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The scanner's lifecycle answers, and the QR it is allowed to show. */
class ScannerStateTest {

    private val origin = "https://relayium.com"

    // ── opening ─────────────────────────────────────────────────────────────

    @Test
    fun `the camera is asked for only when the user opens the scanner`() {
        // Not at launch. A permission prompt for a feature nobody has touched
        // is how people learn to deny.
        assertEquals(
            ScannerState.REQUESTING,
            ScannerTransitions.opened(hasCamera = true, alreadyGranted = false),
        )
        assertEquals(
            ScannerState.RUNNING,
            ScannerTransitions.opened(hasCamera = true, alreadyGranted = true),
        )
    }

    @Test
    fun `a device with no camera never asks for permission to use one`() {
        assertEquals(
            ScannerState.UNAVAILABLE,
            ScannerTransitions.opened(hasCamera = false, alreadyGranted = false),
        )
        // Even with the permission already held: there is nothing to open.
        assertEquals(
            ScannerState.UNAVAILABLE,
            ScannerTransitions.opened(hasCamera = false, alreadyGranted = true),
        )
    }

    // ── answers ─────────────────────────────────────────────────────────────

    @Test
    fun `the two refusals are different states because they need different offers`() {
        assertEquals(ScannerState.RUNNING, ScannerTransitions.answered(CameraPermission.GRANTED))
        assertEquals(ScannerState.DENIED, ScannerTransitions.answered(CameraPermission.DENIED))
        assertEquals(
            ScannerState.DENIED_PERMANENTLY,
            ScannerTransitions.answered(CameraPermission.DENIED_PERMANENTLY),
        )
        // A "try again" button on a permanent denial does nothing and looks
        // broken; a settings link on a first denial is a detour.
        assertTrue(ScannerState.DENIED.canRetry)
        assertFalse(ScannerState.DENIED_PERMANENTLY.canRetry)
        assertTrue(ScannerState.DENIED_PERMANENTLY.needsSettings)
        assertFalse(ScannerState.DENIED.needsSettings)
    }

    @Test
    fun `a device with no camera offers neither retry nor settings`() {
        assertFalse(ScannerState.UNAVAILABLE.canRetry)
        assertFalse(ScannerState.UNAVAILABLE.needsSettings)
    }

    @Test
    fun `a binding failure is worth retrying, because it is often transient`() {
        assertEquals(ScannerState.FAILED, ScannerTransitions.bindFailed())
        assertTrue(ScannerState.FAILED.canRetry)
        assertEquals(ScannerState.RUNNING, ScannerTransitions.retried(ScannerState.FAILED, true))
    }

    // ── going away ──────────────────────────────────────────────────────────

    @Test
    fun `only the running state wants the camera on`() {
        for (state in ScannerState.entries) {
            assertEquals(state.name, state == ScannerState.RUNNING, state.wantsCamera)
        }
    }

    @Test
    fun `leaving the scanner turns it off`() {
        for (state in listOf(ScannerState.RUNNING, ScannerState.REQUESTING, ScannerState.DENIED, ScannerState.FAILED)) {
            assertEquals(state.name, ScannerState.IDLE, ScannerTransitions.stopped(state))
        }
    }

    @Test
    fun `the answers that are still true when the user returns are kept`() {
        // Forgetting these shows a viewfinder that cannot start, then re-asks a
        // question the system will not present.
        assertEquals(ScannerState.UNAVAILABLE, ScannerTransitions.stopped(ScannerState.UNAVAILABLE))
        assertEquals(
            ScannerState.DENIED_PERMANENTLY,
            ScannerTransitions.stopped(ScannerState.DENIED_PERMANENTLY),
        )
    }

    @Test
    fun `retrying asks again after an ordinary refusal and never after a permanent one`() {
        assertEquals(ScannerState.REQUESTING, ScannerTransitions.retried(ScannerState.DENIED, true))
        assertEquals(
            ScannerState.DENIED_PERMANENTLY,
            ScannerTransitions.retried(ScannerState.DENIED_PERMANENTLY, true),
        )
    }

    @Test
    fun `a camera that disappeared is noticed on retry`() {
        // A USB or virtual camera can go away between attempts.
        for (state in ScannerState.entries) {
            assertEquals(state.name, ScannerState.UNAVAILABLE, ScannerTransitions.retried(state, hasCamera = false))
        }
    }

    // ── coming back ─────────────────────────────────────────────────────────

    @Test
    fun `returning from settings with the permission granted just starts`() {
        // The trip the permanent denial sent the user on. Picking the grant up
        // silently is the whole point; prompting again here would be a dialog
        // the system will not even show.
        assertEquals(
            ScannerState.RUNNING,
            ScannerTransitions.resumed(ScannerState.DENIED_PERMANENTLY, hasCamera = true, granted = true),
        )
        assertEquals(
            ScannerState.RUNNING,
            ScannerTransitions.resumed(ScannerState.IDLE, hasCamera = true, granted = true),
        )
    }

    @Test
    fun `returning without the permission never re-prompts`() {
        // A resume that re-entered REQUESTING would prompt every time the user
        // came back — including the return trip from Settings.
        for (state in listOf(ScannerState.IDLE, ScannerState.DENIED, ScannerState.FAILED)) {
            assertEquals(
                state.name,
                ScannerState.DENIED,
                ScannerTransitions.resumed(state, hasCamera = true, granted = false),
            )
        }
        assertEquals(
            ScannerState.DENIED_PERMANENTLY,
            ScannerTransitions.resumed(ScannerState.DENIED_PERMANENTLY, hasCamera = true, granted = false),
        )
    }

    @Test
    fun `returning mid-prompt leaves the prompt alone`() {
        // The activity stops because the permission dialog took the foreground.
        // Answering it is the launcher's job, not the resume's.
        assertEquals(
            ScannerState.REQUESTING,
            ScannerTransitions.resumed(ScannerState.REQUESTING, hasCamera = true, granted = false),
        )
    }

    @Test
    fun `a camera that went away while the app was in the background is noticed`() {
        for (state in ScannerState.entries) {
            assertEquals(
                state.name,
                ScannerState.UNAVAILABLE,
                ScannerTransitions.resumed(state, hasCamera = false, granted = true),
            )
        }
    }

    @Test
    fun `a resume never leaves the sheet blank`() {
        // The bug this closes: stopping leaves IDLE, nothing re-runs on return,
        // and the user is looking at an empty sheet. Every resume lands
        // somewhere that either shows a camera or explains itself.
        for (state in ScannerState.entries) {
            for (granted in listOf(true, false)) {
                val resumed = ScannerTransitions.resumed(state, hasCamera = true, granted = granted)
                assertTrue(
                    "$state/$granted resumed to $resumed",
                    resumed != ScannerState.IDLE,
                )
            }
        }
    }

    // ── the code this device shows ──────────────────────────────────────────

    @Test
    fun `the shown QR is the same link the web and Apple clients build`() {
        assertEquals(
            "https://relayium.com/cross-network#c=042913",
            PairingQr.payload(origin, PairCode("042913"), expiresAt = 0, now = 0),
        )
    }

    @Test
    fun `an acceptance origin produces its own link, with no double slash`() {
        assertEquals(
            "http://10.0.2.2:8080/cross-network#c=042913",
            PairingQr.payload("http://10.0.2.2:8080/", PairCode("042913"), 0, 0),
        )
    }

    @Test
    fun `there is no QR code when nothing has been minted`() {
        assertNull(PairingQr.payload(origin, null, 0, 0))
        assertNull(PairingQr.matrix(origin, null, 0, 0))
    }

    @Test
    fun `an expired code never becomes a scannable square`() {
        // Someone photographs the screen, walks to the other device, and scans
        // a code the server already refuses — and the failure surfaces there,
        // on the device that did nothing wrong.
        val expiresAt = 1_000L
        assertNotNull(PairingQr.payload(origin, PairCode("042913"), expiresAt, now = 999))
        assertNull(PairingQr.payload(origin, PairCode("042913"), expiresAt, now = 1_000))
        assertNull(PairingQr.payload(origin, PairCode("042913"), expiresAt, now = 1_001))
        assertNull(PairingQr.matrix(origin, PairCode("042913"), expiresAt, now = 1_000))
    }

    @Test
    fun `expiry agrees with the countdown beside it, at the same instant`() {
        // Both read PairCodeExpiry, so the surface cannot show a countdown at
        // zero next to a scannable code.
        val expiresAt = 5_000L
        for (now in listOf(4_998L, 4_999L, 5_000L, 5_001L)) {
            val usable = com.relayium.android.account.PairCodeExpiry.presentation(expiresAt, now).usable
            val payload = PairingQr.payload(origin, PairCode("042913"), expiresAt, now)
            assertEquals("at $now", usable, payload != null)
        }
    }

    @Test
    fun `a mint that named no deadline is shown, because the server still owns the real one`() {
        assertNotNull(PairingQr.payload(origin, PairCode("042913"), expiresAt = 0, now = 9_999_999))
    }
}
