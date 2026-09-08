package com.relayium.protocol.stored

import com.relayium.protocol.Crypto
import java.io.Closeable

/**
 * A plaintext byte source read strictly FORWARD.
 *
 * Files are read through this rather than loaded: a 2 GiB selection has to cost
 * one chunk of heap, not two gigabytes of it, and the encryptor below never sees
 * more than [STORE_CHUNK_SIZE] at a time because of it.
 *
 * [read] returns fewer bytes than asked only at the end of input, and an empty
 * array means the source is exhausted. It may throw: a source is a real file
 * behind a document provider, and the caller treats any throw as this file
 * failing rather than as a short read.
 */
interface PlaintextSource : Closeable {
    /** The manifest name this source reports, which for a folder upload is a
     *  forward-slash relative path. */
    val name: String

    /** The size the manifest committed to. */
    val size: Long

    fun read(max: Int): ByteArray

    override fun close() {}
}

/** An in-memory source, for tests and for the small payloads the app composes
 *  itself. */
class BytesSource(override val name: String, private val bytes: ByteArray) : PlaintextSource {
    private var offset = 0
    override val size: Long get() = bytes.size.toLong()
    override fun read(max: Int): ByteArray {
        if (max <= 0 || offset >= bytes.size) return ByteArray(0)
        val end = minOf(offset + max, bytes.size)
        return bytes.copyOfRange(offset, end).also { offset = end }
    }
}

/**
 * Yields the framed ciphertext stream one frame at a time.
 *
 * `seq` is GLOBAL across files and starts at 1, because 0 is the manifest — the
 * same rule the Web encoder and the Swift port follow. There is no separator
 * between files, and a zero-length file yields no frame at all and consumes no
 * sequence number: getting that wrong shifts every later nonce by one and
 * produces a stream that authenticates nothing.
 *
 * Sizes are not re-derived from the sources here. The manifest already committed
 * to them, and [ChunkEncryptor.finish] is what proves the bytes actually read
 * matched that commitment — a source that grew or shrank between staging and
 * upload is a failed upload, not a silently different file.
 */
class ChunkEncryptor(key: ByteArray, private val sources: List<PlaintextSource>) : Closeable {

    private val key = storeKeySpec(key)
    private var index = 0
    private var seq = 1L
    private var readFromCurrent = 0L

    /** The next frame, or null once every source is exhausted. */
    fun next(): ByteArray? {
        while (index < sources.size) {
            val source = sources[index]
            val plaintext = source.read(STORE_CHUNK_SIZE)
            if (plaintext.isEmpty()) {
                // Exhausted. A source that ended early is caught HERE, against
                // the size the manifest promised, rather than at the end of the
                // whole stream where it could not be attributed to a file.
                if (readFromCurrent != source.size) {
                    storedFailure(StoredWireException.Reason.LENGTH_MISMATCH)
                }
                index += 1
                readFromCurrent = 0
                continue
            }
            readFromCurrent += plaintext.size
            // A source that returned MORE than the manifest declared is refused
            // before it is sealed: the extra bytes would be ciphertext no
            // receiver can account for, and the server has already been told a
            // Content-Length that does not include them.
            if (plaintext.size > STORE_CHUNK_SIZE || readFromCurrent > source.size) {
                storedFailure(StoredWireException.Reason.LENGTH_MISMATCH)
            }
            val sealed = Crypto.seal(key, seq, plaintext)
            seq += 1
            return frame(sealed)
        }
        return null
    }

    /** Assert every source delivered exactly what it promised. */
    fun finish() {
        if (index != sources.size) storedFailure(StoredWireException.Reason.LENGTH_MISMATCH)
    }

    override fun close() {
        for (source in sources) runCatching { source.close() }
    }
}

/**
 * The whole framed stream in memory.
 *
 * For tests and for the fixture comparison only. The upload path uses
 * [ChunkEncryptor] directly against the network so a file never has to fit in
 * the heap.
 */
fun encryptChunks(key: ByteArray, files: List<ByteArray>): ByteArray {
    val encryptor = ChunkEncryptor(key, files.mapIndexed { i, bytes -> BytesSource("$i", bytes) })
    val out = java.io.ByteArrayOutputStream()
    while (true) out.write(encryptor.next() ?: break)
    encryptor.finish()
    return out.toByteArray()
}
