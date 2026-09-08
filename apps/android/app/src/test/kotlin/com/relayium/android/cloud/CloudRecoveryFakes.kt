package com.relayium.android.cloud

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * A box whose LABEL binding is the property under test.
 *
 * The obfuscation is deliberately trivial — these are unit tests, not a
 * cryptographic exercise — but the label is verified on open exactly as
 * AES-GCM's additional authenticated data verifies it on the device. That is
 * what lets a JVM test assert the thing that actually matters: a record moved
 * into another job's or another account's slot does not open.
 */
class FakeSecretBox : SecretBox {

    /** Set to make the next seal fail, for the persistence-failure cases. */
    @Volatile
    var sealFails = false

    /** Set to make every open fail, as an invalidated keystore key would. */
    @Volatile
    var openFails = false

    /**
     * Park a seal whose label starts with this, until [releaseSeal].
     *
     * A barrier on one named operation rather than a sleep: it holds a
     * durable write open at a known point so a test can make the account leave
     * INSIDE it, which is the window every post-await admission exists for.
     */
    @Volatile
    var sealGate: String? = null

    @Volatile
    var sealGateEntries = 0
        private set

    private val gate = Object()

    fun releaseSeal() {
        sealGate = null
        synchronized(gate) { gate.notifyAll() }
    }

    override fun seal(label: String, plaintext: ByteArray): ByteArray {
        sealGate?.let { prefix ->
            if (label.startsWith(prefix)) {
                sealGateEntries += 1
                synchronized(gate) {
                    while (sealGate?.let { label.startsWith(it) } == true) gate.wait(10_000)
                }
            }
        }
        if (sealFails) throw SecretBoxException("the test refused this seal")
        val name = label.toByteArray(Charsets.UTF_8)
        require(name.size < 250) { "test label too long" }
        return ByteArray(1 + name.size + plaintext.size).also { out ->
            out[0] = name.size.toByte()
            name.copyInto(out, 1)
            for (i in plaintext.indices) out[1 + name.size + i] = (plaintext[i].toInt() xor 0x5a).toByte()
        }
    }

    override fun open(label: String, sealed: ByteArray): ByteArray {
        if (openFails) throw SecretBoxException("the test refused this open")
        if (sealed.isEmpty()) throw SecretBoxException("empty record")
        val size = sealed[0].toInt() and 0xff
        if (sealed.size < 1 + size) throw SecretBoxException("truncated record")
        val name = String(sealed, 1, size, Charsets.UTF_8)
        // The authenticated-data property, stated as a refusal: a record sealed
        // for one job or account cannot be opened as another's.
        if (name != label) throw SecretBoxException("this record belongs to $name")
        val body = sealed.copyOfRange(1 + size, sealed.size)
        for (i in body.indices) body[i] = (body[i].toInt() xor 0x5a).toByte()
        return body
    }
}

/**
 * The durable-write barriers, with one of them able to fail on demand.
 *
 * The platform implementation is what the app always uses and what the on-device
 * tests exercise; this exists so a JVM test can make a NAMED barrier fail and
 * assert the recovery ordering that follows — which a real `fsync` cannot be
 * asked to do. Nothing here inspects the runtime: it is injected explicitly by
 * the test that wants it.
 */
class ScriptedDurableFiles : DurableFiles {

    /** File names whose atomic write must fail, e.g. `plan.bin`. */
    val failWrites = java.util.Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())

    /** Writes actually performed, in order — the crash-ordering evidence. */
    val writes = java.util.Collections.synchronizedList(ArrayList<String>())

    private val syncs = AtomicInteger(0)

    /** How many directory syncs happened, so a test can assert one occurred. */
    val directorySyncs: Int get() = syncs.get()

    override fun createDirectories(directory: File) {
        if (!directory.isDirectory && !directory.mkdirs()) {
            throw IOException("the test could not create $directory")
        }
        syncs.incrementAndGet()
    }

    override fun writeAtomically(file: File, bytes: ByteArray) {
        if (file.name in failWrites) throw IOException("the test refused to write ${file.name}")
        val directory = file.parentFile ?: throw IOException("no parent")
        if (!directory.isDirectory && !directory.mkdirs()) throw IOException("no directory")
        val temporary = File(directory, "${file.name}.tmp")
        FileOutputStream(temporary).use { it.write(bytes) }
        if (!temporary.renameTo(file)) throw IOException("rename failed")
        writes.add(file.name)
        syncs.incrementAndGet()
    }

    /**
     * Park the sync of ONE named directory until the test releases it.
     *
     * Named rather than global so a barrier can be armed on exactly one
     * operation — a purge syncs the pending root, while a plan write syncs the
     * job's own directory — instead of stalling everything and turning the test
     * into a sleep.
     */
    @Volatile
    var syncGate: File? = null

    private val gate = Object()

    /** How many times the gated sync has been ENTERED, so a test can wait for
     *  the operation to reach the barrier instead of guessing. */
    @Volatile
    var gateEntries = 0
        private set

    /** Let every parked sync through, and stop parking. */
    fun releaseGate() {
        syncGate = null
        synchronized(gate) { gate.notifyAll() }
    }

    override fun syncDirectory(directory: File) {
        if (syncGate?.absolutePath == directory.absolutePath) {
            gateEntries += 1
            synchronized(gate) {
                while (syncGate?.absolutePath == directory.absolutePath) gate.wait(10_000)
            }
        }
        syncs.incrementAndGet()
    }

    override fun syncStream(out: FileOutputStream) {
        out.flush()
    }
}

/**
 * A resumable upload endpoint with the behaviours the real server actually has.
 *
 * Modelled on the observed contract rather than on convenience: PATCH offsets
 * count framed ciphertext from zero and exclude the init header, an append is
 * silently capped, a start below the committed offset is answered 200 and one
 * above it 409, and finalize neither verifies completeness nor returns an object
 * id for a session it has already claimed.
 */
class ResumableUploadServer(
    /** What init advertises. */
    private val chunkSize: Int = 64 * 1024,
    /** The most one append may commit, whatever the client sent. */
    private val appendCap: Int = Int.MAX_VALUE,
    private val objectId: String = "obj00000000000000000000000000000",
    private val expiresAt: Long = 1_800_000_000L,
) : AutoCloseable {

    /** The framed ciphertext the blob holds, in offset order. */
    private val blob = ByteArrayOutputStream()

    /** The init header, stored SEPARATELY exactly as the server stores it. */
    @Volatile
    var header: ByteArray = ByteArray(0)
        private set

    @Volatile
    var initCount = 0
        private set

    @Volatile
    var finalizeCount = 0
        private set

    @Volatile
    var singleShotCount = 0
        private set

    /** Answer the next finalize with 409 and no object id — a session already
     *  claimed, which proves neither publication nor its absence. */
    @Volatile
    var finalizeConflicts = false

    /** Answer every status probe with 404, as an idle reaper leaves it. */
    @Volatile
    var sessionReaped = false

    /** Answer every append with the offset it already had: no progress at all. */
    @Volatile
    var stalled = false

    /** Refuse every append, as a node that has gone away does. */
    @Volatile
    var refuseAppends = false

    /**
     * Refuse an append once the blob holds at least this much.
     *
     * Decided INSIDE the handler, so an interruption is a property of the server
     * rather than a race the test has to win from another thread.
     */
    @Volatile
    var refuseAppendsAfter: Long = Long.MAX_VALUE

    /** Report an offset outside the declared stream, which must be refused. */
    @Volatile
    var impossibleOffset = false

    /** Every Content-Range the client actually sent. */
    val ranges = java.util.Collections.synchronizedList(ArrayList<String>())

    val committed: Int get() = synchronized(blob) { blob.size() }

    fun payload(): ByteArray = synchronized(blob) { blob.toByteArray() }

    private val server = RecordingHttpServer { request, out ->
        when {
            request.method == "POST" && request.path == "/api/uploads" -> {
                initCount += 1
                header = request.body
                // A new session starts a new blob, exactly as a fresh upload
                // session does on the real server.
                synchronized(blob) { blob.reset() }
                RecordingHttpServer.respond(
                    out,
                    body = """{"uploadId":"upload000000000000000000000000","chunkSize":$chunkSize}"""
                        .toByteArray(),
                )
            }

            request.method == "PATCH" && request.path.startsWith("/api/uploads/") -> {
                val range = request.header("Content-Range") ?: ""
                ranges.add(range)
                val start = range.removePrefix("bytes ").substringBefore('-').toLongOrNull() ?: -1
                synchronized(blob) {
                    val have = blob.size().toLong()
                    when {
                        refuseAppends || have >= refuseAppendsAfter -> RecordingHttpServer.respond(
                            out,
                            status = "503 Service Unavailable",
                            body = "storage node unavailable".toByteArray(),
                        )
                        impossibleOffset -> RecordingHttpServer.respond(
                            out,
                            body = """{"received":999999999}""".toByteArray(),
                        )
                        stalled -> RecordingHttpServer.respond(
                            out,
                            body = """{"received":$have}""".toByteArray(),
                        )
                        // A start past what the blob holds is a gap: 409 with
                        // the authoritative offset, and nothing is written.
                        start > have -> RecordingHttpServer.respond(
                            out,
                            status = "409 Conflict",
                            body = """{"received":$have}""".toByteArray(),
                        )
                        // A start below it is a replay of bytes already held:
                        // acknowledged at the offset the blob actually has.
                        start < have -> RecordingHttpServer.respond(
                            out,
                            body = """{"received":$have}""".toByteArray(),
                        )
                        else -> {
                            val take = minOf(request.body.size, appendCap)
                            blob.write(request.body, 0, take)
                            RecordingHttpServer.respond(
                                out,
                                body = """{"received":${blob.size()}}""".toByteArray(),
                            )
                        }
                    }
                }
            }

            request.method == "GET" && request.path.startsWith("/api/uploads/") -> {
                if (sessionReaped) {
                    RecordingHttpServer.respond(out, status = "404 Not Found", body = ByteArray(0))
                } else {
                    RecordingHttpServer.respond(
                        out,
                        body = """{"received":${committed}}""".toByteArray(),
                    )
                }
            }

            request.method == "POST" && request.path.endsWith("/finalize") -> {
                finalizeCount += 1
                if (finalizeConflicts) {
                    RecordingHttpServer.respond(
                        out,
                        status = "409 Conflict",
                        body = "already finalized".toByteArray(),
                    )
                } else {
                    RecordingHttpServer.respond(
                        out,
                        body = """{"id":"$objectId","expiresAt":$expiresAt}""".toByteArray(),
                    )
                }
            }

            // The single-shot route, so a selection below the staging threshold
            // exercises the accepted path against the same server.
            request.method == "POST" && request.path == "/api/files" -> {
                singleShotCount += 1
                RecordingHttpServer.respond(
                    out,
                    body = """{"id":"$objectId","expiresAt":$expiresAt}""".toByteArray(),
                )
            }

            else -> RecordingHttpServer.respond(out, status = "404 Not Found", body = ByteArray(0))
        }
    }

    val origin: String get() = server.origin

    override fun close() = server.close()
}
