package com.relayium.android.inbox

import com.relayium.protocol.inbox.InboxDeviceErrorCode
import com.relayium.protocol.inbox.InboxProtocol
import com.relayium.protocol.inbox.InboxRejection
import com.relayium.protocol.inbox.InboxTaskState
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap

/**
 * A scriptable Device Inbox server.
 *
 * The transport itself is tested against a real socket (`InboxTransportTest`);
 * what this exists for is the layers ABOVE it, whose interesting behaviour is
 * what they do when a registration response is lost, when a lease is refused
 * mid-download, or when central's history disagrees with the local one. None of
 * that is reachable through a URL stub, and all of it is a few lines here.
 *
 * Every call is recorded in [calls] in order, because several of the properties
 * under test are about what was NOT done — no second key minted after an
 * ambiguous failure, no rotation performed without a person asking.
 */
class FakeInboxTransport(
    var deviceId: String = InboxFixtures.DEVICE_ID,
) : InboxDeviceTransport, InboxSenderTransport {

    /** Method names in call order, e.g. `registerKey`, `listKeys`. */
    val calls: MutableList<String> = Collections.synchronizedList(ArrayList())

    /** Central's key history for this device, oldest first. */
    val keys: MutableList<InboxKeyRow> = Collections.synchronizedList(ArrayList())

    /** Rows returned by `devices`. Defaults to one current device with no key. */
    var devices: List<InboxDeviceRow> = emptyList()

    var enrolResult: InboxEnrolResult? = null

    /** Thrown by the next `registerKey`, then cleared. */
    var registerFailure: Throwable? = null

    /** Thrown by every `listKeys` while set. */
    var listKeysFailure: Throwable? = null

    /** What `registerKey` records as the compare-and-swap input it was given. */
    val previousKeyIds: MutableList<String?> = Collections.synchronizedList(ArrayList())

    /** Ids minted for registered keys, so a test can assert identity. */
    private val minted = ConcurrentHashMap<String, String>()
    private var nextKeyOrdinal = 1

    var pending: List<InboxTaskRow> = emptyList()
    var claimResult: InboxClaimResult = InboxClaimResult(emptyList(), 0)
    val reports: MutableList<Triple<String, InboxTaskState, InboxDeviceErrorCode>> =
        Collections.synchronizedList(ArrayList())
    val accepts: MutableList<Pair<String, Boolean>> = Collections.synchronizedList(ArrayList())

    /** Ciphertext handed to `withBlob`, by task id. */
    val blobs: MutableMap<String, ByteArray> = ConcurrentHashMap()

    /** Thrown by `report` once this many reports have succeeded, so a refusal can
     *  be placed on the `saved` call rather than on every call. */
    var reportFailureAfter: Int = 0

    /** Thrown by `report` while set, subject to [reportFailureAfter]. */
    var reportFailure: Throwable? = null

    /** The state the task row carries back from a successful report; a server
     *  that answered with something other than what was asserted is a case the
     *  caller has to notice. */
    var savedTaskState: InboxTaskState? = null

    /** The id the report's task row carries back, so an answer about ANOTHER
     *  task is drivable. */
    var savedTaskId: String? = null

    /** Thrown by the next `withBlob`, then cleared. */
    var blobFailure: Throwable? = null

    /** Cut the FIRST stream after this many bytes, forcing a resume. */
    var breakAfterBytes: Int = 0

    /** Answer a ranged request with the whole object, as a server that ignores
     *  `Range` would — which a receiver must detect rather than splice. */
    var ignoreRange: Boolean = false

    /** Offsets `withBlob` was called with, in order. */
    val blobOffsets: MutableList<Long> = Collections.synchronizedList(ArrayList())

    override suspend fun currentDevice(): InboxDeviceRow {
        calls.add("currentDevice")
        return devices.firstOrNull { it.isCurrent }
            ?: throw InboxWireException(InboxWireReason.IDENTITY_MISMATCH, "Current")
    }

    override suspend fun devices(): List<InboxDeviceRow> {
        calls.add("devices")
        return devices
    }

    override suspend fun enrol(request: InboxEnrolRequest): InboxEnrolResult {
        calls.add("enrol")
        return enrolResult ?: InboxEnrolResult(
            inbox = InboxEnrolmentView.read(
                InboxFixtures.enrolment(
                    "AutoAccept" to com.relayium.protocol.Json.of(request.autoAccept.wire),
                    "ReceiveDirReady" to com.relayium.protocol.Json.of(request.receiveDirReady),
                    "Key" to null,
                ),
            ),
            protocolVersion = InboxProtocol.MAX_PROTOCOL_VERSION,
            receiveCapability = com.relayium.protocol.inbox.InboxCapability.REQUIRED_RECEIVE,
            keyAlgorithm = InboxProtocol.KEY_ALGORITHM,
        )
    }

    /**
     * Mints an id for a new public key and supersedes the previous active one,
     * exactly as the server's compare-and-swap does.
     */
    override suspend fun registerKey(
        algorithm: String,
        publicKey: String,
        previousKeyId: String?,
    ): InboxKeyRow {
        calls.add("registerKey")
        previousKeyIds.add(previousKeyId)
        registerFailure?.let { registerFailure = null; throw it }
        val active = keys.lastOrNull { it.isActive }
        if (previousKeyId != active?.id) {
            throw InboxApiException(409, InboxRejection.STALE_KEY_ROTATION)
        }
        if (keys.any { it.publicKey == publicKey }) {
            throw InboxApiException(409, InboxRejection.DEVICE_KEY_REUSED)
        }
        if (active != null) {
            keys[keys.indexOf(active)] = active.copy(supersededAt = 1_700_000_100L)
        }
        val id = minted.getOrPut(publicKey) { "key%030d".format(nextKeyOrdinal++) }
        val row = InboxKeyRow(
            id = id, algorithm = algorithm, publicKey = publicKey,
            generation = keys.size + 1L, createdAt = 1_700_000_000L,
            supersededAt = 0, revokedAt = 0,
        )
        keys.add(row)
        return row
    }

    override suspend fun listKeys(): List<InboxKeyRow> {
        calls.add("listKeys")
        listKeysFailure?.let { throw it }
        return keys.toList()
    }

    override suspend fun heartbeat(receiveDirReady: Boolean): InboxHeartbeatResult {
        calls.add("heartbeat")
        return InboxHeartbeatResult(
            com.relayium.protocol.inbox.InboxPresence.ONLINE,
            1_700_000_090L, InboxProtocol.DEFAULT_HEARTBEAT_SECONDS,
        )
    }

    override suspend fun goOffline() {
        calls.add("goOffline")
    }

    override suspend fun pending(limit: Int): List<InboxTaskRow> {
        calls.add("pending")
        return pending
    }

    override suspend fun claim(max: Int): InboxClaimResult {
        calls.add("claim")
        return claimResult
    }

    override suspend fun <T> withBlob(
        taskId: String,
        claimToken: String,
        offset: Long,
        consume: suspend (InboxBlobStream) -> T,
    ): T {
        calls.add("withBlob")
        blobOffsets.add(offset)
        blobFailure?.let { blobFailure = null; throw it }
        val whole = blobs[taskId] ?: ByteArray(0)
        // A server that ignores `Range` answers a resume with the whole object
        // and a 200. The stream reports itself as non-partial, which is what the
        // receiver has to notice.
        val body = if (ignoreRange) whole
        else whole.copyOfRange(offset.toInt().coerceAtMost(whole.size), whole.size)
        val cut = if (breakAfterBytes > 0 && offset == 0L) breakAfterBytes else 0
        if (cut > 0) breakAfterBytes = 0
        return consume(
            ByteArrayBlobStream(
                body, offset, whole.size.toLong(),
                partial = offset > 0 && !ignoreRange,
                breakAfter = cut,
            ),
        )
    }

    override suspend fun report(
        taskId: String,
        claimToken: String,
        state: InboxTaskState,
        errorCode: InboxDeviceErrorCode,
        committed: Boolean,
    ): InboxTaskRow {
        calls.add("report")
        reports.add(Triple(taskId, state, errorCode))
        reportFailure?.let {
            if (reports.size > reportFailureAfter) throw it
        }
        val answeredState = if (state == InboxTaskState.SAVED) {
            savedTaskState ?: state
        } else {
            state
        }
        return InboxTaskRow.read(
            InboxFixtures.task(
                "ID" to com.relayium.protocol.Json.of(
                    if (state == InboxTaskState.SAVED) savedTaskId ?: taskId else taskId,
                ),
                "State" to com.relayium.protocol.Json.of(answeredState.wire),
                "Terminal" to com.relayium.protocol.Json.of(answeredState.isTerminal),
            ),
        )
    }

    override suspend fun accept(taskId: String, accept: Boolean): InboxTaskRow {
        calls.add("accept")
        accepts.add(taskId to accept)
        return InboxTaskRow.read(InboxFixtures.task())
    }

    override suspend fun clearInbox() {
        calls.add("clearInbox")
    }

    override suspend fun createTask(
        targetDeviceId: String,
        request: InboxSendRequest,
    ): InboxTaskCreation = throw UnsupportedOperationException("not scripted")

    override suspend fun task(targetDeviceId: String, taskId: String): InboxTaskRow =
        throw UnsupportedOperationException("not scripted")

    override suspend fun tasks(targetDeviceId: String, limit: Int): List<InboxTaskRow> =
        throw UnsupportedOperationException("not scripted")

    override suspend fun cancelTask(targetDeviceId: String, taskId: String) =
        throw UnsupportedOperationException("not scripted")

    /** How many times [name] was called. */
    fun count(name: String): Int = calls.count { it == name }
}

/**
 * A blob stream over bytes already in hand.
 *
 * [breakAfter] cuts the stream mid-flight with an `IOException`, which is what a
 * dropped connection looks like to the reader — the case the receiver's resume
 * exists for, and one that cannot be produced by simply returning fewer bytes
 * (that would look like a clean end of stream).
 */
class ByteArrayBlobStream(
    private val bytes: ByteArray,
    offset: Long,
    total: Long,
    partial: Boolean = offset > 0,
    private val breakAfter: Int = 0,
) : InboxBlobStream {
    private var position = 0

    override val status: Int = if (partial) 206 else 200
    override val isPartial: Boolean = partial
    override val rangeStart: Long = if (partial) offset else -1

    init {
        require(total >= 0)
    }

    override fun read(into: ByteArray): Int {
        if (breakAfter > 0 && position >= breakAfter) {
            throw java.io.IOException("the test cut the connection")
        }
        if (position >= bytes.size) return -1
        var n = minOf(into.size, bytes.size - position)
        if (breakAfter > 0) n = minOf(n, breakAfter - position)
        bytes.copyInto(into, 0, position, position + n)
        position += n
        return n
    }
}

/**
 * Durable-write barriers whose DIRECTORY sync can be made to fail by name.
 *
 * The shared `ScriptedDurableFiles` can fail a write; what several publication
 * cases need is the other barrier — a rename that lands and an fsync that does
 * not, which is the exact shape that would otherwise let a retry report `saved`
 * for a directory entry no crash would have preserved. A real fsync cannot be
 * asked to fail, so it is injected here.
 */
class SyncFailingDurableFiles(
    private val delegate: com.relayium.android.cloud.DurableFiles,
) : com.relayium.android.cloud.DurableFiles {

    /** Absolute paths whose directory sync must fail. */
    val failSyncs: MutableSet<String> = java.util.Collections.newSetFromMap(ConcurrentHashMap())

    /** Directories synced, in order, so a test can assert one happened. */
    val syncedDirectories: MutableList<String> =
        java.util.Collections.synchronizedList(ArrayList())

    override fun createDirectories(directory: java.io.File) = delegate.createDirectories(directory)

    override fun writeAtomically(file: java.io.File, bytes: ByteArray) =
        delegate.writeAtomically(file, bytes)

    override fun syncDirectory(directory: java.io.File) {
        if (directory.absolutePath in failSyncs) {
            throw java.io.IOException("the test refused to sync ${directory.name}")
        }
        syncedDirectories.add(directory.absolutePath)
        delegate.syncDirectory(directory)
    }

    override fun syncStream(out: java.io.FileOutputStream) = delegate.syncStream(out)
}
