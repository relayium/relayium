package com.relayium.protocol

import java.util.Base64

/**
 * Byte-level helpers every layer of `link/1` needs, in one place so the wire
 * never depends on a call site remembering the endianness.
 *
 * Kotlin's `Byte` is signed, which is the single most common source of a wrong
 * wire byte in a port from JavaScript or Swift. Everything here goes through
 * `toInt() and 0xff`, and every unsigned read returns a wider type than the
 * field it read, so a 32-bit sequence number can never arrive as a negative
 * `Int` and compare backwards.
 */
internal object Bytes {

    /** Lower-case hex, the encoding every fixture and every `DONE_ENC` uses. */
    fun hex(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            out.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
        }
        return out.toString()
    }

    /** Strict: an odd length or a non-hex digit is a decode failure, never a
     *  silently truncated value. */
    fun unhex(text: String): ByteArray {
        require(text.length % 2 == 0) { "hex string has odd length ${text.length}" }
        val out = ByteArray(text.length / 2)
        for (i in out.indices) {
            val hi = digit(text[i * 2])
            val lo = digit(text[i * 2 + 1])
            out[i] = ((hi shl 4) or lo).toByte()
        }
        return out
    }

    private fun digit(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        in 'A'..'F' -> c - 'A' + 10
        else -> throw IllegalArgumentException("not a hex digit: $c")
    }

    private const val HEX = "0123456789abcdef"

    /**
     * Standard RFC 4648 base64 WITH padding — `btoa`'s alphabet, not the
     * URL-safe one.
     *
     * `relayium-link-v1.md` section 4.5: a 32-byte HMAC encodes to exactly 44
     * characters, and the length check that bounds verification work is only
     * meaningful against this alphabet. `Base64.getUrlEncoder()` would produce
     * the same length and a different, silently incompatible string.
     */
    fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    /** Decode, or null. A malformed tag is a refusal, never a throw into a
     *  signalling dispatch loop. */
    fun unbase64OrNull(text: String): ByteArray? = try {
        Base64.getDecoder().decode(text)
    } catch (_: IllegalArgumentException) {
        null
    }

    /** Big-endian uint32 read, widened to `Long` so a value above 2^31-1 cannot
     *  arrive negative and compare backwards against a sequence counter. */
    fun readUInt32(source: ByteArray, offset: Int): Long {
        require(offset + 4 <= source.size) { "uint32 read past end" }
        return ((source[offset].toLong() and 0xff) shl 24) or
            ((source[offset + 1].toLong() and 0xff) shl 16) or
            ((source[offset + 2].toLong() and 0xff) shl 8) or
            (source[offset + 3].toLong() and 0xff)
    }

    /** Big-endian uint32 write. The value must fit; a wider sequence number is a
     *  caller bug the wire cannot express (see `RealtimeFrame.MAX_SEQ`). */
    fun writeUInt32(target: ByteArray, offset: Int, value: Long) {
        require(value in 0..0xffff_ffffL) { "value $value does not fit a uint32" }
        target[offset] = ((value ushr 24) and 0xff).toByte()
        target[offset + 1] = ((value ushr 16) and 0xff).toByte()
        target[offset + 2] = ((value ushr 8) and 0xff).toByte()
        target[offset + 3] = (value and 0xff).toByte()
    }

    /** Big-endian IEEE-754 double, which is what the flow-control ACK carries. */
    fun writeFloat64(target: ByteArray, offset: Int, value: Double) {
        var bits = java.lang.Double.doubleToRawLongBits(value)
        for (i in 7 downTo 0) {
            target[offset + i] = (bits and 0xff).toByte()
            bits = bits ushr 8
        }
    }

    fun readFloat64(source: ByteArray, offset: Int): Double {
        var bits = 0L
        for (i in 0 until 8) bits = (bits shl 8) or (source[offset + i].toLong() and 0xff)
        return java.lang.Double.longBitsToDouble(bits)
    }

    fun concat(vararg parts: ByteArray): ByteArray {
        val out = ByteArray(parts.sumOf { it.size })
        var at = 0
        for (part in parts) {
            part.copyInto(out, at)
            at += part.size
        }
        return out
    }

    /**
     * Length-independent, value-constant-time equality.
     *
     * Lengths are compared first and in the clear, which leaks only a length the
     * caller already fixed by construction at every call site here.
     */
    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean {
        if (a.size != b.size) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].toInt() xor b[i].toInt())
        return diff == 0
    }

    /** Bytewise unsigned comparison. The ordering `crypto.ts`'s `compareBytes`
     *  and `sas` use, and the one the resume-auth key derivation sorts by. */
    fun compare(a: ByteArray, b: ByteArray): Int {
        val len = minOf(a.size, b.size)
        for (i in 0 until len) {
            val diff = (a[i].toInt() and 0xff) - (b[i].toInt() and 0xff)
            if (diff != 0) return diff
        }
        return a.size - b.size
    }

    /** Overwrite a secret in place. Best effort on the JVM, and worth doing
     *  anyway: it bounds how long a session key sits in a heap dump. */
    fun wipe(secret: ByteArray) = secret.fill(0)
}
