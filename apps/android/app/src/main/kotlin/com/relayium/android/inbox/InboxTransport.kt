package com.relayium.android.inbox

import com.relayium.protocol.inbox.InboxAutoAccept
import com.relayium.protocol.inbox.InboxDeviceErrorCode
import com.relayium.protocol.inbox.InboxProtocol
import com.relayium.protocol.inbox.InboxTaskState

/**
 * The two halves of the Device Inbox API, kept apart on purpose.
 *
 * The split mirrors the one central already makes
 * (`server/account/deviceinbox_task.go`), and it is the security decision on
 * this file:
 *
 *  * [InboxDeviceTransport] is constructed around ONE device id — its own — and
 *    every path it builds sits under that id. Enrolment, key custody, presence,
 *    claiming and progress reports are assertions about what THIS MACHINE is
 *    doing with a file, and a caller that could switch identities would erase
 *    the property that makes the receiver safe.
 *  * [InboxSenderTransport] is the opposite: it addresses every device the
 *    account owns except, normally, itself. The target id is therefore a
 *    per-call argument, checked on every call, and this half holds no device
 *    identity at all.
 *
 * Interfaces rather than the concrete client because the interesting behaviour
 * is what the layers above do when a lease is refused mid-download, when a
 * resume is answered with a full body, or when a create's answer is lost — and
 * none of that is reachable through a URL stub.
 */

/** What this device announces about itself at enrolment. Bounded, negotiable
 *  metadata; nothing here is derived from a received file. */
data class InboxEnrolRequest(
    val platform: String,
    val appVersion: String,
    val autoAccept: InboxAutoAccept,
    val receiveDirReady: Boolean,
    val protocolVersions: List<Int> = InboxProtocol.VERSIONS,
    val capabilities: List<String>,
)

/**
 * One ciphertext stream, valid ONLY inside the
 * [InboxDeviceTransport.withBlob] block that produced it.
 *
 * Deliberately not `Closeable`, and deliberately not returned: see the doc on
 * `withBlob`. Its lifetime is the block's, so there is no handle for a caller
 * to leak, to close twice, or to read after the socket is gone.
 *
 * [isPartial] must be checked by the caller: a resume answered with a full `200`
 * is NOT a tail, and splicing a fresh start into the middle of a stream would
 * produce authenticated-looking rubbish. The body is never buffered — a delivery
 * is arbitrarily large, and holding one in the heap is what this path avoids.
 */
interface InboxBlobStream {
    val status: Int

    /** Whether the server honoured a `Range` request with `206`. */
    val isPartial: Boolean

    /** The server's `Content-Range` start, or -1 when it sent none. Compared
     *  against the requested offset before a single byte is fed to a decryptor. */
    val rangeStart: Long

    /** Fill [into], returning the count or -1 at end of stream. */
    fun read(into: ByteArray): Int
}

/** The calls a RECEIVING device makes. Every one is device-self. */
interface InboxDeviceTransport {

    /**
     * The device row this bearer authenticates as.
     *
     * A native client cannot assume its device id: it is minted server-side when
     * a login is approved, so the honest way to learn it is to ask which row is
     * `Current`. A cookie caller marks no row and this client only ever sends a
     * bearer, so at most one row can be current.
     */
    suspend fun currentDevice(): InboxDeviceRow

    suspend fun enrol(request: InboxEnrolRequest): InboxEnrolResult

    /**
     * Publish a public key. [previousKeyId] is the compare-and-swap input: null
     * means "I have no key yet" and is refused if one exists; otherwise it must
     * name the currently active key. That is what makes a captured registration
     * request useless on replay.
     */
    suspend fun registerKey(
        algorithm: String,
        publicKey: String,
        previousKeyId: String?,
    ): InboxKeyRow

    suspend fun listKeys(): List<InboxKeyRow>

    suspend fun heartbeat(receiveDirReady: Boolean): InboxHeartbeatResult

    /** The graceful goodbye of a receiver pausing or shutting down: presence
     *  expires now instead of leaving senders to wait out the TTL. */
    suspend fun goOffline()

    suspend fun pending(limit: Int): List<InboxTaskRow>

    suspend fun claim(max: Int): InboxClaimResult

    /**
     * Open the task's ciphertext, resuming at [offset] when non-zero, and hand
     * it to [consume] for exactly as long as that block runs.
     *
     * A CALLBACK rather than a returned handle, and that is the whole design.
     * The alternative — return an open stream and let the caller close it —
     * splits one lifetime across two owners, and every version of that split has
     * a hole in it: a cancellation landing between "the response is in hand" and
     * "the caller received it" leaks a live socket; a lifetime tied to the
     * caller's own completion cannot fire while the caller is blocked reading;
     * and a lifetime tied to a child of the caller keeps the caller from ever
     * completing if the handle is dropped. Here the response is opened, consumed
     * and closed inside one scope, with the cancellation watcher spanning the
     * whole of it, so none of those states is representable.
     *
     * Cancelling the caller therefore tears the socket down under a blocked
     * read, which is what actually unblocks it, and the body is closed on every
     * exit path including that one.
     */
    suspend fun <T> withBlob(
        taskId: String,
        claimToken: String,
        offset: Long,
        consume: suspend (InboxBlobStream) -> T,
    ): T

    /**
     * Record progress, the final commit, or a failure. Repeating the current
     * state is an idempotent no-op, which is how a long download renews its
     * lease without a second endpoint.
     */
    suspend fun report(
        taskId: String,
        claimToken: String,
        state: InboxTaskState,
        errorCode: InboxDeviceErrorCode,
        committed: Boolean,
    ): InboxTaskRow

    /** Resolve an `attention_required` task from THIS machine: true re-queues
     *  it, false ends it as `failed_terminal`/`user_declined`. */
    suspend fun accept(taskId: String, accept: Boolean): InboxTaskRow

    /** Remove this device's enrolment and its whole key history, which also
     *  terminates its unfinished tasks as revoked. It must succeed before any
     *  local private key is destroyed. */
    suspend fun clearInbox()
}

/** The account-scoped calls a SENDING client makes. */
interface InboxSenderTransport {

    /** Every device on the account, including this one. Which are eligible
     *  targets is a product decision (see [InboxTargetEligibility]), not a
     *  transport one. */
    suspend fun devices(): List<InboxDeviceRow>

    suspend fun createTask(targetDeviceId: String, request: InboxSendRequest): InboxTaskCreation

    suspend fun task(targetDeviceId: String, taskId: String): InboxTaskRow

    suspend fun tasks(targetDeviceId: String, limit: Int): List<InboxTaskRow>

    suspend fun cancelTask(targetDeviceId: String, taskId: String)
}
