package com.relayium.protocol.stored

import com.relayium.protocol.Crypto
import java.security.GeneralSecurityException
import javax.crypto.spec.SecretKeySpec

/** Plaintext bytes per chunk. The last chunk of a file is NOT padded. */
const val STORE_CHUNK_SIZE = 192 * 1024

/** The 4-byte length prefix plus the 16-byte GCM tag. */
const val FRAME_OVERHEAD = 4 + 16

/**
 * The largest ciphertext a frame may declare.
 *
 * A decoder MUST check the length prefix against this BEFORE allocating: the
 * prefix arrives from the network and is the one field an attacker controls
 * completely, so an unchecked `ByteArray(len)` is a 4-byte remote OOM.
 */
const val MAX_FRAME_CT = STORE_CHUNK_SIZE + 16 + 256

internal fun storeKeySpec(key: ByteArray): SecretKeySpec {
    if (key.size != STORE_KEY_BYTES) storedFailure(StoredWireException.Reason.INVALID_KEY)
    return SecretKeySpec(key, "AES")
}

internal fun writeU32be(target: ByteArray, offset: Int, value: Int) {
    target[offset] = (value ushr 24).toByte()
    target[offset + 1] = (value ushr 16).toByte()
    target[offset + 2] = (value ushr 8).toByte()
    target[offset + 3] = value.toByte()
}

/** Unsigned, so a prefix with the high bit set reads as a large length to be
 *  refused rather than as a negative one that skips the bound check. */
internal fun readU32be(source: ByteArray, offset: Int): Long =
    ((source[offset].toLong() and 0xff) shl 24) or
        ((source[offset + 1].toLong() and 0xff) shl 16) or
        ((source[offset + 2].toLong() and 0xff) shl 8) or
        (source[offset + 3].toLong() and 0xff)

/**
 * The upload body's header: `uint32BE(len(encManifest)) || encManifest`.
 *
 * The manifest travels UNFRAMED, length-prefixed, ahead of the frame stream —
 * `docs/protocol/relayium-stored-wire-v1.md`, and what `server/account/files.go`
 * reads first. It lives here beside [frame] so one file owns every length
 * prefix this wire has; assembling it at the transport would be the second
 * place a prefix could be written differently.
 */
fun uploadHeader(encManifest: ByteArray): ByteArray {
    val out = ByteArray(4 + encManifest.size)
    writeU32be(out, 0, encManifest.size)
    encManifest.copyInto(out, 4)
    return out
}

/** One framed chunk: `uint32BE(len(ct)) || ct`. */
fun frame(ciphertext: ByteArray): ByteArray {
    val out = ByteArray(4 + ciphertext.size)
    writeU32be(out, 0, ciphertext.size)
    ciphertext.copyInto(out, 4)
    return out
}

/**
 * The exact wire size of the framed stream for files of these plaintext sizes.
 *
 * Exact, not an estimate: it is the `Content-Length` an upload declares, and the
 * server meters and quota-checks against what the client says it will send. A
 * zero-byte file contributes NOTHING — it produces no chunk, so it costs no
 * frame and consumes no sequence number.
 *
 * Every size is bounded and every step is checked, because this is an EXPORTED
 * boundary that runs on sizes which may have come off the wire in a manifest.
 * Unchecked `Long` arithmetic here would wrap a hostile set of sizes into a
 * small, plausible `Content-Length` — a body that then disagrees with its own
 * declared length, which is the shape of a request smuggling bug rather than a
 * merely wrong number. A refusal is the only safe answer, and it is the same
 * refusal [validateManifestFiles] gives.
 */
fun cipherSize(sizes: List<Long>): Long {
    var total = 0L
    for (size in sizes) {
        if (size < 0 || size > MANIFEST_MAX_SAFE_INTEGER) {
            storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
        }
        val chunks = (size + STORE_CHUNK_SIZE - 1) / STORE_CHUNK_SIZE
        total = try {
            Math.addExact(total, Math.addExact(size, Math.multiplyExact(FRAME_OVERHEAD.toLong(), chunks)))
        } catch (_: ArithmeticException) {
            storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
        }
        if (total > MANIFEST_MAX_SAFE_INTEGER) {
            storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
        }
    }
    return total
}

/**
 * Reassembles the framed ciphertext stream across arbitrary byte-stream
 * boundaries and yields authenticated plaintext chunks in order.
 *
 * Network chunking is not frame chunking: one `read` can hold three frames and
 * half of a fourth, and the next can complete that half. Everything about the
 * layout is therefore recovered from the length prefixes, never from how bytes
 * happened to arrive.
 *
 * ## What it refuses, and why each refusal is load-bearing
 *
 * * **An over-long length prefix**, before allocating (see [MAX_FRAME_CT]).
 * * **A frame that fails authentication.** GCM is checked per frame, which
 *   catches an altered byte — but per-frame authentication is NOT whole-file
 *   verification, which is why the two checks below exist.
 * * **A dangling partial frame at the end** ([end]): a stream cut mid-frame is
 *   truncation, not a clean finish.
 * * **A decrypted total that disagrees with the manifest** ([end]). This is the
 *   one an attacker actually reaches: cutting the stream on a frame BOUNDARY
 *   leaves every delivered frame perfectly authentic, so the only thing that
 *   distinguishes "the file ended" from "someone stopped the file early" is the
 *   size the manifest committed to.
 *
 * Not thread-safe: one decryptor belongs to one download.
 */
class StoreDecryptor(key: ByteArray) {

    private val key = storeKeySpec(key)
    private var seq = 1L
    private var buffer = ByteArray(0)
    private var buffered = 0

    /** Plaintext bytes released to the caller so far. */
    var decryptedBytes: Long = 0L
        private set

    /**
     * Ciphertext bytes consumed in COMPLETE, authenticated frames.
     *
     * The only sound resume offset. It advances past a frame only once that
     * frame has authenticated, so a `Range` request starting here can neither
     * re-feed a partial frame nor skip one. The buffered tail of an interrupted
     * frame is deliberately not counted: it is precisely the part whose
     * authenticity is still unknown.
     */
    var consumedCipher: Long = 0L
        private set

    /**
     * Drop the tail of an incomplete frame before a resumed read.
     *
     * Required, not tidiness: a reconnect restarts at [consumedCipher], so a
     * buffered partial frame would be prepended to bytes that already contain
     * it and everything after would decode as rubbish. Nothing authenticated is
     * discarded — [seq], [decryptedBytes] and [consumedCipher] all describe
     * complete frames and are untouched.
     */
    fun resetBuffer() {
        buffered = 0
    }

    /** Feed arrived bytes; returns whatever whole frames they completed. */
    fun push(data: ByteArray): List<ByteArray> {
        append(data)
        val out = ArrayList<ByteArray>()
        var offset = 0
        while (offset + 4 <= buffered) {
            val length = readU32be(buffer, offset)
            if (length > MAX_FRAME_CT) storedFailure(StoredWireException.Reason.FRAME_TOO_LARGE)
            val end = offset + 4 + length.toInt()
            if (end > buffered) break                       // frame still incomplete
            val ciphertext = buffer.copyOfRange(offset + 4, end)
            val plaintext = try {
                Crypto.open(key, seq, ciphertext)
            } catch (_: GeneralSecurityException) {
                // An authentication failure is never a soft result: these bytes
                // are not the sender's, and there is no recovery that keeps them.
                storedFailure(StoredWireException.Reason.TRUNCATED_STREAM)
            }
            seq += 1
            offset = end
            decryptedBytes += plaintext.size
            consumedCipher += 4L + length
            out.add(plaintext)
        }
        compact(offset)
        return out
    }

    /**
     * End of stream. [expectedBytes] is the manifest's plaintext total when it
     * is known, which is what turns a boundary-aligned truncation into an error.
     */
    fun end(expectedBytes: Long?) {
        if (buffered != 0) storedFailure(StoredWireException.Reason.TRUNCATED_STREAM)
        if (expectedBytes != null && decryptedBytes != expectedBytes) {
            storedFailure(StoredWireException.Reason.LENGTH_MISMATCH)
        }
    }

    /**
     * Buffer growth is bounded by construction: [push] consumes every complete
     * frame before returning, so what survives a call is one incomplete frame —
     * at most `4 + MAX_FRAME_CT` — plus the bytes of the caller's final read.
     */
    private fun append(data: ByteArray) {
        val needed = buffered + data.size
        if (needed > buffer.size) buffer = buffer.copyOf(maxOf(needed, buffer.size * 2))
        data.copyInto(buffer, buffered)
        buffered = needed
    }

    private fun compact(consumed: Int) {
        if (consumed == 0) return
        buffer.copyInto(buffer, 0, consumed, buffered)
        buffered -= consumed
    }
}
