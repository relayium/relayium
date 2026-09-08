package com.relayium.protocol.inbox

import com.relayium.protocol.Bytes
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Arrays
import java.util.Base64
import org.bouncycastle.crypto.digests.Blake2bDigest
import org.bouncycastle.crypto.engines.Salsa20Engine
import org.bouncycastle.crypto.engines.XSalsa20Engine
import org.bouncycastle.crypto.macs.Poly1305
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.ParametersWithIV
import org.bouncycastle.math.ec.rfc7748.X25519
import org.bouncycastle.util.Pack

/**
 * `x25519-sealedbox-v1`: libsodium's `crypto_box_seal`, composed from the
 * lightweight BouncyCastle primitives this module already pins.
 *
 * ```
 * ephemeral_pk = X25519_base(ephemeral_sk)                   // fresh per seal
 * k            = HSalsa20(X25519(ephemeral_sk, target_pk), zero16)
 * nonce        = BLAKE2b-24(ephemeral_pk || target_pk)
 * stream       = XSalsa20(k, nonce)
 * ciphertext   = content_key XOR stream[32…]
 * tag          = Poly1305(stream[0…32), ciphertext)
 * sealed       = ephemeral_pk || tag || ciphertext
 * ```
 *
 * A composition rather than a primitive, so it is reproduced here for the same
 * reason [com.relayium.protocol.Crypto] reproduces `crypto_kx`: neither the JDK
 * nor Android has it, and installing a JCE provider would change crypto for
 * every other consumer in the process. Three details a port gets wrong, each
 * pinned by a vector libsodium itself produced:
 *
 *  1. The tag comes BEFORE the ciphertext — `crypto_box_easy`'s combined mode,
 *     not AES-GCM's trailing tag.
 *  2. The Poly1305 key is the first 32 keystream bytes as `r || s`, unswapped.
 *  3. HSalsa20 is the Salsa20 core with the feed-forward SUBTRACTED, taking
 *     words 0, 5, 10, 15, 6, 7, 8, 9. `Salsa20Engine.salsaCore` adds the input
 *     state back in, so using its output directly keys everything wrongly.
 *
 * This is the only place in the module that touches a device private key or an
 * unwrapped content key. Persistence belongs to a platform key store; nothing
 * here logs, and the failures carry a reason and no values.
 */
object InboxKeyMaterial {

    // ── encoding ────────────────────────────────────────────────────────────

    /** base64url without padding, matching central's `EncodePublicKey` and the
     *  `#k=` content-key encoding, so a client has one rule everywhere. */
    fun encode(raw: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(raw)

    /**
     * The STRICT inverse, refusing everything that is not the ONE spelling of
     * [expecting] bytes.
     *
     * Strictness is not pedantry: an encoded key is an IDENTITY here — "is this
     * the key central named?" is a string comparison — so padding, whitespace,
     * the `+`/`/` alphabet and non-canonical trailing bits are all refusals.
     *
     * The length is checked FIRST, against the exact unpadded base64 length of
     * [expecting] bytes (43 for a public key, 107 for a wrapped key), so a
     * megabyte of "key" arriving from a clipboard or a queue row is refused
     * before it is scanned or decoded into a buffer.
     *
     * The re-encode is the check `Base64` does not make on its own: "AB" and
     * "AC" decode to the same byte, so a decoder that stops at the byte count
     * accepts two spellings of one key.
     */
    fun decode(encoded: String, expecting: Int): ByteArray {
        if (expecting > 0) {
            if (encoded.length != unpaddedBase64Length(expecting)) {
                fail(InboxKeyReason.MALFORMED_KEY_MATERIAL)
            }
        } else {
            // Unpadded base64 cannot have a remainder of 1: no number of 6-bit
            // groups produces a single trailing character.
            if (encoded.isEmpty() || encoded.length % 4 == 1) {
                fail(InboxKeyReason.MALFORMED_KEY_MATERIAL)
            }
        }
        val alphabet = encoded.all {
            it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_'
        }
        if (!alphabet) fail(InboxKeyReason.MALFORMED_KEY_MATERIAL)
        val raw = try {
            Base64.getUrlDecoder().decode(encoded)
        } catch (_: IllegalArgumentException) {
            fail(InboxKeyReason.MALFORMED_KEY_MATERIAL)
        }
        if (encode(raw) != encoded) fail(InboxKeyReason.MALFORMED_KEY_MATERIAL)
        if (expecting > 0 && raw.size != expecting) fail(InboxKeyReason.MALFORMED_KEY_MATERIAL)
        return raw
    }

    /** Characters in the unpadded base64 spelling of [bytes] bytes: four per
     *  three-byte group, and one per remaining 6 bits. */
    private fun unpaddedBase64Length(bytes: Int): Int = (bytes * 8 + 5) / 6

    // ── public-key validation ───────────────────────────────────────────────

    /** The domain string central derives its low-order probe scalar from,
     *  written here so the two sides cannot drift. */
    private const val LOW_ORDER_PROBE_DOMAIN = "relayium-device-inbox-loworder-probe-v1"

    /**
     * Validate an announced public key exactly as central's `ValidatePublicKey`
     * does, in the same order: unknown algorithm, non-canonical base64url, wrong
     * length, then a low-order point.
     *
     * A device that generated a key central would refuse must find that out
     * HERE, before it is persisted and long before a sender wraps to it.
     */
    fun validatePublicKey(algorithm: String, encoded: String): ByteArray {
        if (algorithm != InboxProtocol.KEY_ALGORITHM) fail(InboxKeyReason.UNSUPPORTED_ALGORITHM)
        val raw = decode(encoded, InboxProtocol.PUBLIC_KEY_BYTES)
        if (isLowOrder(raw)) fail(InboxKeyReason.UNUSABLE_PUBLIC_KEY)
        return raw
    }

    /**
     * True for a public key whose X25519 exchange yields the all-zero shared
     * secret. Such a key parses, is the right length, and every content key
     * "wrapped" to it is recoverable by anybody who saw the queue row.
     *
     * A FIXED probe scalar, derived from central's own domain string: any
     * clamped scalar gives the same answer, because a low-order point drives the
     * exchange to zero regardless of what it is multiplied by. The return code
     * is the check rather than a list of literal points a future curve
     * implementation could extend — false is libsodium's `crypto_scalarmult`
     * contract and Go's `ecdh` error for exactly this set.
     */
    fun isLowOrder(publicKey: ByteArray): Boolean {
        if (publicKey.size != InboxProtocol.PUBLIC_KEY_BYTES) return true
        val probe = MessageDigest.getInstance("SHA-256")
            .digest(LOW_ORDER_PROBE_DOMAIN.toByteArray(Charsets.US_ASCII))
        val shared = ByteArray(InboxProtocol.PUBLIC_KEY_BYTES)
        val agreed = X25519.calculateAgreement(probe, 0, publicKey, 0, shared, 0)
        Bytes.wipe(shared)
        Bytes.wipe(probe)
        return !agreed
    }

    // ── key generation ──────────────────────────────────────────────────────

    private val random = SecureRandom()

    /**
     * Mint a fresh device key, then re-validate its own public half.
     *
     * Not ceremony: a key central would reject must fail before it is persisted,
     * and never silently retried — publishing an unusable public key would make
     * every task sealed to it undecryptable by anybody, including its owner.
     */
    fun generateKeyPair(): InboxDeviceKeyPair {
        val secret = ByteArray(InboxProtocol.SECRET_KEY_BYTES)
        random.nextBytes(secret)
        val public = ByteArray(InboxProtocol.PUBLIC_KEY_BYTES)
        X25519.scalarMultBase(secret, 0, public, 0)
        try {
            validatePublicKey(InboxProtocol.KEY_ALGORITHM, encode(public))
        } catch (_: InboxKeyException) {
            Bytes.wipe(secret)
            fail(InboxKeyReason.GENERATION_FAILED)
        }
        return InboxDeviceKeyPair(public, secret).also { Bytes.wipe(secret) }
    }

    // ── sealing ─────────────────────────────────────────────────────────────

    /**
     * Wrap a content key to a TARGET device's announced public key, producing
     * the `wrappedKey` a task create carries.
     *
     * The target goes through [validatePublicKey] first, and its low-order
     * clause is why this cannot be a bare seal: such a key would drive the
     * exchange to the all-zero shared secret, publishing the user's file key to
     * anybody who saw the queue row while every status in the UI stayed green.
     *
     * Both lengths are exact. What is wrapped is fixed by this protocol version,
     * so a short content key must fail here rather than produce a box the
     * receiver refuses hours later with an error that reads as corruption.
     */
    fun sealContentKey(algorithm: String, targetPublicKey: String, contentKey: ByteArray): String {
        val recipient = validatePublicKey(algorithm, targetPublicKey)
        if (contentKey.size != InboxProtocol.CONTENT_KEY_BYTES) {
            fail(InboxKeyReason.MALFORMED_KEY_MATERIAL)
        }
        val ephemeralSecret = ByteArray(InboxProtocol.SECRET_KEY_BYTES)
        random.nextBytes(ephemeralSecret)
        val sealed = try {
            sealRaw(recipient, contentKey, ephemeralSecret)
        } finally {
            Bytes.wipe(ephemeralSecret)
        }
        if (sealed.size != InboxProtocol.SEALED_BOX_BYTES) fail(InboxKeyReason.SEAL_FAILED)
        return encode(sealed)
    }

    /**
     * Open a wrapped key and return the content key.
     *
     * The sealed box is length-checked before any crypto runs, exactly rather
     * than as a bound: any other length is a peer sealing something else, and a
     * change to what is sealed has to be a new algorithm token. The RESULT is
     * checked too — everything downstream is keyed by it, and a short key must
     * fail here rather than at an AEAD call whose error reads as "corrupt data".
     */
    fun unsealContentKey(
        algorithm: String,
        wrappedKey: String,
        keyPair: InboxDeviceKeyPair,
    ): ByteArray {
        if (algorithm != InboxProtocol.KEY_ALGORITHM) fail(InboxKeyReason.UNSUPPORTED_ALGORITHM)
        val sealed = decode(wrappedKey, InboxProtocol.SEALED_BOX_BYTES)
        val content = openRaw(sealed, keyPair)
        if (content.size != InboxProtocol.CONTENT_KEY_BYTES) {
            Bytes.wipe(content)
            fail(InboxKeyReason.UNSEAL)
        }
        return content
    }

    /**
     * The composition itself, with the ephemeral secret supplied by the caller.
     *
     * Internal because choosing the ephemeral key chooses the whole box: reusing
     * one across two seals to the same recipient repeats the nonce and the
     * XSalsa20 keystream. [sealContentKey] is the only production path and draws
     * a fresh secret per call; the module's suite uses this to reproduce
     * libsodium's byte-exact deterministic vector.
     */
    internal fun sealRaw(
        recipientPublic: ByteArray,
        message: ByteArray,
        ephemeralSecret: ByteArray,
    ): ByteArray {
        val ephemeralPublic = ByteArray(InboxProtocol.PUBLIC_KEY_BYTES)
        X25519.scalarMultBase(ephemeralSecret, 0, ephemeralPublic, 0)
        val key = beforeNm(ephemeralSecret, recipientPublic)
        val stream = try {
            keystream(key, sealNonce(ephemeralPublic, recipientPublic), 32 + message.size)
        } finally {
            Bytes.wipe(key)
        }
        val ciphertext = ByteArray(message.size) { i ->
            (message[i].toInt() xor stream[32 + i].toInt()).toByte()
        }
        val polyKey = stream.copyOf(32)
        val tag = poly1305(polyKey, ciphertext)
        Bytes.wipe(polyKey)
        Bytes.wipe(stream)
        return Bytes.concat(ephemeralPublic, tag, ciphertext)
    }

    /**
     * The inverse of [sealRaw], under the recipient's own key pair.
     *
     * Every failure below the typed boundary — a low-order ephemeral key in the
     * box, a key pair whose halves belong to different identities, an array a
     * primitive did not like — arrives as [InboxKeyReason.UNSEAL]. Both halves
     * of that matter: the caller's response is identical in every case, and
     * naming the difference would be an oracle; and this runs on bytes a peer
     * chose, so a raw library exception escaping here would be an unhandled
     * crash on hostile input rather than a refused delivery.
     */
    internal fun openRaw(sealed: ByteArray, keyPair: InboxDeviceKeyPair): ByteArray {
        val prefix = InboxProtocol.PUBLIC_KEY_BYTES + InboxProtocol.POLY1305_TAG_BYTES
        if (sealed.size < prefix) fail(InboxKeyReason.UNSEAL)
        val ephemeralPublic = sealed.copyOf(InboxProtocol.PUBLIC_KEY_BYTES)
        val ciphertext = sealed.copyOfRange(prefix, sealed.size)
        val secret = keyPair.privateKeyCopy()
        try {
            val key = beforeNm(secret, ephemeralPublic)
            val stream = try {
                keystream(key, sealNonce(ephemeralPublic, keyPair.publicKey), 32 + ciphertext.size)
            } finally {
                Bytes.wipe(key)
            }
            val polyKey = stream.copyOf(32)
            val tag = poly1305(polyKey, ciphertext)
            Bytes.wipe(polyKey)
            if (!Bytes.constantTimeEquals(sealed.copyOfRange(InboxProtocol.PUBLIC_KEY_BYTES, prefix), tag)) {
                Bytes.wipe(stream)
                fail(InboxKeyReason.UNSEAL)
            }
            val message = ByteArray(ciphertext.size) { i ->
                (ciphertext[i].toInt() xor stream[32 + i].toInt()).toByte()
            }
            Bytes.wipe(stream)
            return message
        } catch (e: InboxKeyException) {
            // A destroyed key pair is the caller's own bug and keeps its own
            // reason; everything else collapses to the opaque one.
            if (e.reason == InboxKeyReason.DESTROYED) throw e
            fail(InboxKeyReason.UNSEAL)
        } catch (_: RuntimeException) {
            fail(InboxKeyReason.UNSEAL)
        } finally {
            Bytes.wipe(secret)
        }
    }

    // ── the primitives crypto_box_seal is composed from ─────────────────────

    /**
     * `crypto_box_beforenm`: the X25519 shared point run through HSalsa20 with a
     * 16-byte zero nonce.
     *
     * The raw X25519 output is NOT the key. Skipping HSalsa20 produces a box
     * this client would round-trip with itself and no libsodium peer could open.
     *
     * Internal, like [sealNonce] and [poly1305], so the suite can pin each step
     * against a published known-answer test: a composition wrong in two places
     * can still round-trip with itself.
     */
    internal fun beforeNm(secret: ByteArray, publicKey: ByteArray): ByteArray {
        val shared = ByteArray(InboxProtocol.PUBLIC_KEY_BYTES)
        if (!X25519.calculateAgreement(secret, 0, publicKey, 0, shared, 0)) {
            Bytes.wipe(shared)
            fail(InboxKeyReason.UNUSABLE_PUBLIC_KEY)
        }
        val state = IntArray(16)
        // Constants at 0, 5, 10, 15; key in 1-4 and 11-14; the nonce words 6-9
        // stay ZERO, which is what makes this `beforenm` and not a keyed HSalsa20.
        for (i in 0 until 4) state[i * 5] = Pack.littleEndianToInt(SIGMA, i * 4)
        for (i in 0 until 4) {
            state[1 + i] = Pack.littleEndianToInt(shared, i * 4)
            state[11 + i] = Pack.littleEndianToInt(shared, 16 + i * 4)
        }
        val core = IntArray(16)
        Salsa20Engine.salsaCore(20, state, core)
        val out = ByteArray(32)
        for (i in HSALSA20_WORDS.indices) {
            Pack.intToLittleEndian(core[HSALSA20_WORDS[i]] - state[HSALSA20_WORDS[i]], out, i * 4)
        }
        Bytes.wipe(shared)
        Arrays.fill(state, 0)
        Arrays.fill(core, 0)
        return out
    }

    private val SIGMA = "expand 32-byte k".toByteArray(Charsets.US_ASCII)
    private val HSALSA20_WORDS = intArrayOf(0, 5, 10, 15, 6, 7, 8, 9)

    /**
     * DERIVED rather than random, because both ends must reach it from the box
     * alone. The ephemeral key is fresh per seal, so this is unique without a
     * nonce field on the wire.
     */
    internal fun sealNonce(ephemeralPublic: ByteArray, recipientPublic: ByteArray): ByteArray {
        val digest = Blake2bDigest(24 * 8)
        digest.update(ephemeralPublic, 0, ephemeralPublic.size)
        digest.update(recipientPublic, 0, recipientPublic.size)
        return ByteArray(24).also { digest.doFinal(it, 0) }
    }

    /** XSalsa20 keystream. The first 32 bytes become the one-time Poly1305 key
     *  and never encrypt anything; the rest is the pad. */
    private fun keystream(key: ByteArray, nonce: ByteArray, length: Int): ByteArray {
        val engine = XSalsa20Engine()
        engine.init(true, ParametersWithIV(KeyParameter(key), nonce))
        val out = ByteArray(length)
        engine.processBytes(ByteArray(length), 0, length, out, 0)
        return out
    }

    /** Raw Poly1305 over the ciphertext, keyed `r || s` with no swap. */
    internal fun poly1305(polyKey: ByteArray, ciphertext: ByteArray): ByteArray {
        val mac = Poly1305()
        mac.init(KeyParameter(polyKey))
        mac.update(ciphertext, 0, ciphertext.size)
        return ByteArray(16).also { mac.doFinal(it, 0) }
    }

    private fun fail(reason: InboxKeyReason): Nothing = throw InboxKeyException(reason)
}

/**
 * One X25519 identity, in the raw 32-byte spellings central validates.
 *
 * Named `InboxDeviceKeyPair` rather than `KeyPair` because
 * [com.relayium.protocol.Crypto] already has one for the realtime key exchange:
 * two different key types for two different protocols, and one name for both
 * would be a mistake waiting for a call site.
 *
 * Both lengths are checked HERE. A key pair is assembled from whatever a key
 * store read back, and a short half would otherwise reach a primitive and come
 * back as an index-out-of-bounds from a crypto library rather than as a typed
 * refusal this protocol's callers can branch on.
 *
 * Both halves are COPIED in and out, so a caller that wipes its own buffer
 * cannot silently empty this one, and one that mutates what it reads back
 * cannot corrupt the stored key.
 */
class InboxDeviceKeyPair(publicKey: ByteArray, privateKey: ByteArray) {

    private val storedPublic: ByteArray
    private val storedPrivate: ByteArray

    @Volatile
    private var destroyed = false

    init {
        if (publicKey.size != InboxProtocol.PUBLIC_KEY_BYTES ||
            privateKey.size != InboxProtocol.SECRET_KEY_BYTES
        ) {
            throw InboxKeyException(InboxKeyReason.MALFORMED_KEY_MATERIAL)
        }
        storedPublic = publicKey.copyOf()
        storedPrivate = privateKey.copyOf()
    }

    val publicKey: ByteArray
        get() {
            alive()
            return storedPublic.copyOf()
        }

    /**
     * A COPY of the private scalar, for the one caller that legitimately needs
     * it: the platform key store that persists this identity across restarts.
     * Wipe it when the store is done — nothing else outside [InboxKeyMaterial]
     * reads a device private key.
     */
    fun privateKeyCopy(): ByteArray {
        alive()
        return storedPrivate.copyOf()
    }

    /** Best effort: bounds how long the scalar sits in a heap that may be
     *  swapped or written to a crash dump. */
    fun destroy() {
        destroyed = true
        Bytes.wipe(storedPrivate)
        Bytes.wipe(storedPublic)
    }

    /**
     * Using a destroyed pair is refused EXPLICITLY rather than left to produce
     * zeroed key material. A wiped scalar still multiplies, so the box would
     * simply fail to open and read as "the sender wrapped this wrongly" — a
     * wrong answer to a lifetime bug in this process.
     */
    private fun alive() {
        if (destroyed) throw InboxKeyException(InboxKeyReason.DESTROYED)
    }

    /** Redacted by construction: a key pair that printed itself would put a
     *  device private key into whatever log line interpolated it. */
    override fun toString(): String = "InboxDeviceKeyPair(redacted)"
}

/** Why key material was refused. Closed, and carrying no values. */
enum class InboxKeyReason {
    /** Not canonical unpadded base64url, or the wrong length for what it names. */
    MALFORMED_KEY_MATERIAL,

    /** A syntactically valid public key that must never be used: a low-order
     *  Curve25519 point drives every exchange to the all-zero shared secret. */
    UNUSABLE_PUBLIC_KEY,

    /**
     * The sealed box did not open under this device's key.
     *
     * Deliberately opaque: distinguishing "wrong key" from "tampered box" from
     * "low-order ephemeral key" would leak an oracle, and the caller's response
     * is the same either way — the task cannot be decrypted here.
     */
    UNSEAL,

    /** A wrap algorithm token this build does not implement. */
    UNSUPPORTED_ALGORITHM,

    /** This device could not mint an identity central would accept. */
    GENERATION_FAILED,

    /** A SEND could not be wrapped. Separate from [GENERATION_FAILED] because
     *  the remedy differs. */
    SEAL_FAILED,

    /** A key pair was used after [InboxDeviceKeyPair.destroy]. A caller bug, and
     *  kept distinct from [UNSEAL] so it cannot be read as a peer's mistake. */
    DESTROYED,
}

/** Carries the reason and nothing else — no key, no length, no encoded input. */
class InboxKeyException(val reason: InboxKeyReason) :
    RuntimeException("relayium inbox key: $reason")
