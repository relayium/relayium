package com.relayium.android.nearby

/**
 * The intentionally small stream surface local signalling runs on.
 *
 * Handlers may be installed or cleared from a thread other than the one
 * delivering bytes, so implementations synchronise those properties. The
 * interfaces exist so [LocalPeerSignalingChannel] — where every ordering rule
 * lives — is testable on a plain JVM against a scripted transport, with no
 * `NsdManager`, no sockets and no emulator.
 */
interface LocalPeerConnection {
    var onBytes: ((ByteArray, Int) -> Unit)?
    var onClosed: (() -> Unit)?
    fun start()
    fun send(bytes: ByteArray)
    fun cancel()
}

interface LocalPeerTransportDelegate {
    fun localPeerTransportDidStart()
    /** Terminal for this transport. The channel closes; the model may reopen. */
    fun localPeerTransportDidFail(reason: LocalPeerFailure)
    /** The CURRENT browse result, whole. Not a delta. */
    fun localPeerTransportDidDiscover(peers: List<LocalPeerAdvertisement>)
    fun localPeerTransportDidAccept(connection: LocalPeerConnection)
}

/**
 * Why a local transport could not run, as a stable identifier the UI maps to
 * copy. Never a raw platform message: `NsdManager`'s error codes are integers
 * and its failures are not user-facing sentences.
 */
enum class LocalPeerFailure {
    /** Registering the service failed, or the platform RENAMED the instance —
     *  see [LocalPeerAdvertisement.parse], which refuses a renamed record, so
     *  advertising under a name no peer will accept is a failure, not a
     *  degraded success. */
    ADVERTISE,
    /** Browsing failed to start or stopped reporting. */
    DISCOVER,
    /** Neither half reached ready inside the arming window. On Android the
     *  usual cause is a link with no multicast — a hotel/guest Wi-Fi, a
     *  disabled radio — and on a future target it will also be a refused local
     *  network permission. Recoverable: the model reopens on a bounded backoff. */
    UNAVAILABLE,
}

/**
 * Browsing only REPORTS advertisements. [connect] is the sole dial path and is
 * called only for a peer the user explicitly chose — which is the property that
 * makes "listing does not connect" structural rather than a rule to remember.
 */
interface LocalPeerTransport {
    fun start(advertisement: LocalPeerAdvertisement, delegate: LocalPeerTransportDelegate)
    fun connect(peer: LocalPeerAdvertisement): LocalPeerConnection
    fun stop()
}
