package com.relayium.android.scan

/**
 * What the scanner surface is doing, and what the person looking at it can do
 * about it.
 *
 * Every state below is one the user can actually reach, and each has a
 * different actionable answer — which is why they are distinct rather than one
 * `error` with a message. The states a scanner usually conflates are exactly
 * the ones where the difference matters: "you said no" can be fixed by asking
 * again, "you said never" can only be fixed in Settings, and "this device has
 * no camera" cannot be fixed at all and must not offer to try.
 */
enum class ScannerState {
    /** Not started. The camera is not open and no permission has been asked. */
    IDLE,

    /**
     * The system permission dialog is up.
     *
     * Reached only when the user opened the scanner. Asking for the camera at
     * launch would be a permission prompt for a feature nobody has touched,
     * and it teaches people to deny.
     */
    REQUESTING,

    /** Bound to the lifecycle and analysing frames. */
    RUNNING,

    /** Permission refused, and asking again is still allowed. */
    DENIED,

    /**
     * Refused in a way the system will not prompt for again.
     *
     * The only actionable offer is a link to the app's settings page; a "try
     * again" button here does nothing at all and looks broken.
     */
    DENIED_PERMANENTLY,

    /** No camera on this device. Nothing to grant, nothing to retry. */
    UNAVAILABLE,

    /**
     * The camera exists and permission was given, and binding still failed —
     * another app holds it, the provider did not come up, the configuration
     * was rejected. Retrying is worth offering, because this one is often
     * transient.
     */
    FAILED;

    /** Whether the camera should be running in this state. Read by the binder
     *  rather than recomputed at each call site, so "off screen means off"
     *  has one answer. */
    val wantsCamera: Boolean get() = this == RUNNING

    /** Whether asking the system again could change anything. */
    val canRetry: Boolean get() = this == DENIED || this == FAILED

    /** Whether the only way forward is the system settings page. */
    val needsSettings: Boolean get() = this == DENIED_PERMANENTLY
}

/**
 * The permission answer, as the three outcomes that lead somewhere different.
 *
 * `shouldShowRequestPermissionRationale` is how Android distinguishes the
 * second refusal from the final one, and it is only meaningful immediately
 * after a denial — so the reading is taken there and turned into this, rather
 * than being asked again later from a composable that cannot know.
 */
enum class CameraPermission { GRANTED, DENIED, DENIED_PERMANENTLY }

/**
 * The scanner's transitions, as a pure function.
 *
 * Kept out of the Compose and CameraX code so the lifecycle rules — which are
 * the part that goes wrong — are host-testable. Every transition is total: a
 * state machine that silently ignored an event it did not expect is how a
 * scanner ends up stuck on a black rectangle.
 */
object ScannerTransitions {

    /**
     * The user opened the scanner.
     *
     * [alreadyAsked] is what keeps a recreation from becoming a prompt loop.
     * A rotation disposes the sheet and composes it again: without this, every
     * rotation of a device whose owner declined once is another system dialog,
     * and the way to stop them is to decline permanently. Asking once per
     * scanner and then offering a button the user presses themselves is the
     * same information without the badgering.
     */
    fun opened(
        hasCamera: Boolean,
        alreadyGranted: Boolean,
        alreadyAsked: Boolean = false,
    ): ScannerState = when {
        !hasCamera -> ScannerState.UNAVAILABLE
        alreadyGranted -> ScannerState.RUNNING
        alreadyAsked -> ScannerState.DENIED
        else -> ScannerState.REQUESTING
    }

    /** The system answered the permission request. */
    fun answered(permission: CameraPermission): ScannerState = when (permission) {
        CameraPermission.GRANTED -> ScannerState.RUNNING
        CameraPermission.DENIED -> ScannerState.DENIED
        CameraPermission.DENIED_PERMANENTLY -> ScannerState.DENIED_PERMANENTLY
    }

    /** Binding the camera threw or never produced a provider. */
    fun bindFailed(): ScannerState = ScannerState.FAILED

    /**
     * The surface stopped being visible.
     *
     * Everything collapses to [ScannerState.IDLE] EXCEPT the answers that are
     * still true when the user comes back: a device with no camera still has
     * none, and a permanent denial is still permanent. Forgetting those would
     * show a viewfinder that cannot start, then re-ask a question the system
     * will not present.
     */
    fun stopped(current: ScannerState): ScannerState = when (current) {
        ScannerState.UNAVAILABLE, ScannerState.DENIED_PERMANENTLY -> current
        else -> ScannerState.IDLE
    }

    /**
     * The surface became visible again — returning from the background, or
     * from the system settings page.
     *
     * **It never asks for permission.** That is the difference between this
     * and [opened], and it is the whole reason it exists: a resume that
     * re-entered [ScannerState.REQUESTING] would prompt every time the user
     * came back, including the return trip from the settings page they were
     * sent to precisely because the system will not prompt any more. So a
     * grant that appeared while the app was away is picked up silently, and an
     * absent one lands on an actionable refusal with a button the user presses
     * themselves.
     *
     * Not re-checking at all is the other failure, and it is the one the sheet
     * had: [stopped] leaves [ScannerState.IDLE], nothing re-runs on return, and
     * the user is looking at an empty sheet with no camera and no explanation.
     */
    fun resumed(current: ScannerState, hasCamera: Boolean, granted: Boolean): ScannerState = when {
        !hasCamera -> ScannerState.UNAVAILABLE
        granted -> ScannerState.RUNNING
        // The permission went away while the app was in the background, or was
        // never given. Either way the honest state is a refusal the user can
        // act on, not a silent prompt.
        current == ScannerState.DENIED_PERMANENTLY -> ScannerState.DENIED_PERMANENTLY
        current == ScannerState.REQUESTING -> ScannerState.REQUESTING
        else -> ScannerState.DENIED
    }

    /** The user asked to try again after a refusal or a failure. */
    fun retried(current: ScannerState, hasCamera: Boolean): ScannerState = when {
        !hasCamera -> ScannerState.UNAVAILABLE
        current == ScannerState.DENIED_PERMANENTLY -> current
        current == ScannerState.FAILED -> ScannerState.RUNNING
        current == ScannerState.DENIED -> ScannerState.REQUESTING
        else -> current
    }
}
