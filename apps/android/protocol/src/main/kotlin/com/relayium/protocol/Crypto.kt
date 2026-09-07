package com.relayium.protocol

import java.security.GeneralSecurityException
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.crypto.digests.Blake2bDigest
import org.bouncycastle.math.ec.rfc7748.X25519

/**
 * The crypto layer of `link/1`, byte-pinned to `docs/protocol/relayium-crypto-v1.md`
 * and to `apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json`.
 *
 * ## What is borrowed and what is not
 *
 * Two primitives come from BouncyCastle because the JDK and Android have
 * neither: raw X25519 scalar multiplication (`rfc7748.X25519`) and BLAKE2b
 * (`Blake2bDigest`). Everything else — AES-256-GCM, HMAC-SHA-256, SHA-256,
 * SecureRandom, base64 — comes from the platform.
 *
 * The BouncyCastle **JCE provider is deliberately NOT installed**. Registering
 * `BouncyCastleProvider` would change which implementation every other consumer
 * in the process gets for every algorithm, which is a large, invisible blast
 * radius in exchange for nothing: the two primitives above are reached through
 * their lightweight classes directly.
 *
 * ## What is reimplemented, and why that is safe
 *
 * libsodium's `crypto_kx_*_session_keys` is not a primitive; it is a named
 * composition of X25519 and BLAKE2b-512, and this file reproduces that
 * composition exactly ([deriveSession]). That is the one place a hand-rolled
 * step could silently differ from the browser and the Apple clients, so it is
 * pinned to the shared golden vectors — both directions' keys, the SAS, the
 * commitment and the resume MAC — before anything opens a socket. No primitive
 * is invented anywhere in this file.
 */
object Crypto {

    // ── sizes ───────────────────────────────────────────────────────────────

    const val PUBLIC_KEY_BYTES = 32
    const val SECRET_KEY_BYTES = 32
    const val SESSION_KEY_BYTES = 32
    const val COMMIT_BYTES = 32
    const val COMMIT_NONCE_BYTES = 32
    const val AEAD_NONCE_BYTES = 12
    const val AEAD_TAG_BYTES = 16
    const val AEAD_TAG_BITS = AEAD_TAG_BYTES * 8

    /**
     * Domain separation for the message lane's keys.
     *
     * **17 bytes**, including the trailing NUL: `relayium-text-v1` is sixteen
     * ASCII characters plus U+0000. Two protocol documents said 18 until
     * 2026-09-07; the literal never changed, and a port that pads to 18 derives
     * a different key and decrypts nothing the browser sends.
     */
    val TEXT_KEY_DOMAIN: ByteArray = "relayium-text-v1\u0000".toByteArray(Charsets.US_ASCII)

    /** 24 bytes including the trailing NUL. */
    val RESUME_AUTH_DOMAIN: ByteArray = "relayium-resume-auth-v1\u0000".toByteArray(Charsets.US_ASCII)

    // `relayium-preupload-v1\0` (22 bytes) is deliberately absent. This client
    // does not announce `preupload/1`, so it can never legally receive frame
    // kind 12, and carrying the derivation for a capability it does not claim
    // would be code with no reachable caller and a key with no owner.

    init {
        // Sizes asserted at load rather than trusted: every one of them is a
        // constant of a wire two other implementations already speak, and a
        // silent disagreement here is a link that opens and then desynchronises.
        require(TEXT_KEY_DOMAIN.size == 17) { "text key domain must be 17 bytes" }
        require(RESUME_AUTH_DOMAIN.size == 24) { "resume-auth domain must be 24 bytes" }
    }

    // ── key pairs ───────────────────────────────────────────────────────────

    class KeyPair(val publicKey: ByteArray, private val secretKey: ByteArray) {
        internal fun secret(): ByteArray = secretKey
        /** Best effort: bounds how long the scalar sits in a heap dump. */
        fun destroy() = Bytes.wipe(secretKey)
    }

    private val random = SecureRandom()

    /**
     * A fresh `crypto_kx` keypair.
     *
     * libsodium stores the secret unclamped and clamps during the
     * multiplication; RFC 7748's `decodeScalar25519` inside BouncyCastle does
     * the same, so 32 random bytes plus `scalarMultBase` is byte-identical to
     * `crypto_kx_keypair`.
     *
     * A fresh pair per ESTABLISHMENT, never per app run: `relayium-link-v1.md`
     * section 5.5 — one link owns one set of session keys for its lifetime, and
     * a second link must not be able to reuse the first's nonce space.
     */
    fun generateKeyPair(): KeyPair {
        val secret = ByteArray(SECRET_KEY_BYTES)
        random.nextBytes(secret)
        val public = ByteArray(PUBLIC_KEY_BYTES)
        X25519.scalarMultBase(secret, 0, public, 0)
        return KeyPair(public, secret)
    }

    // ── session keys ────────────────────────────────────────────────────────

    enum class Role { INITIATOR, RESPONDER }

    /**
     * Everything one authenticated link is keyed with. Constructed once per
     * establishment and never rebuilt for a new batch or a reopened
     * conversation.
     */
    class SessionKeys internal constructor(
        internal val sendKey: ByteArray,
        internal val recvKey: ByteArray,
        internal val resumeAuthKey: ByteArray,
        internal val textSendKey: ByteArray,
        internal val textRecvKey: ByteArray,
    ) {
        internal val send = SecretKeySpec(sendKey, "AES")
        internal val recv = SecretKeySpec(recvKey, "AES")
        internal val textSend = SecretKeySpec(textSendKey, "AES")
        internal val textRecv = SecretKeySpec(textRecvKey, "AES")

        fun destroy() {
            Bytes.wipe(sendKey); Bytes.wipe(recvKey); Bytes.wipe(resumeAuthKey)
            Bytes.wipe(textSendKey); Bytes.wipe(textRecvKey)
        }
    }

    /** The peer offered a public key this protocol refuses to agree on. */
    class LowOrderKeyException : GeneralSecurityException(
        "relayium: peer public key produced an all-zero shared secret",
    )

    /**
     * libsodium `crypto_kx_client_session_keys` / `crypto_kx_server_session_keys`,
     * reproduced exactly.
     *
     * ```
     * q  = X25519(selfSecret, peerPublic)                       // refuse all-zero
     * h  = BLAKE2b-512(q || clientPublic || serverPublic)       // 64 bytes, unkeyed
     * initiator (client):  rx = h[0..32),  tx = h[32..64)
     * responder (server):  rx = h[32..64), tx = h[0..32)
     * ```
     *
     * Two details a port gets wrong and the golden vectors catch:
     *
     * 1. **The hash input is always `client_pk || server_pk`, in that order**,
     *    for BOTH roles. It is not "self then peer".
     * 2. **The halves are swapped by role, not the input.** That mirroring is
     *    what makes one side's `tx` the other's `rx` with no extra round trip.
     *
     * The all-zero check is not optional. `X25519.calculateAgreement` returns
     * false exactly when the peer offered a small-order point, which is
     * libsodium's own `crypto_scalarmult` contract; continuing would give both
     * ends a shared secret an attacker also knows.
     */
    @Throws(LowOrderKeyException::class)
    fun deriveSession(role: Role, self: KeyPair, peerPublic: ByteArray): SessionKeys {
        require(peerPublic.size == PUBLIC_KEY_BYTES) {
            "peer public key must be $PUBLIC_KEY_BYTES bytes, got ${peerPublic.size}"
        }
        val shared = ByteArray(PUBLIC_KEY_BYTES)
        val ok = X25519.calculateAgreement(self.secret(), 0, peerPublic, 0, shared, 0)
        if (!ok) {
            Bytes.wipe(shared)
            throw LowOrderKeyException()
        }
        val clientPublic = if (role == Role.INITIATOR) self.publicKey else peerPublic
        val serverPublic = if (role == Role.INITIATOR) peerPublic else self.publicKey

        val digest = Blake2bDigest(512)
        digest.update(shared, 0, shared.size)
        digest.update(clientPublic, 0, clientPublic.size)
        digest.update(serverPublic, 0, serverPublic.size)
        val both = ByteArray(2 * SESSION_KEY_BYTES)
        digest.doFinal(both, 0)
        Bytes.wipe(shared)

        val first = both.copyOfRange(0, SESSION_KEY_BYTES)
        val second = both.copyOfRange(SESSION_KEY_BYTES, 2 * SESSION_KEY_BYTES)
        Bytes.wipe(both)

        val rx = if (role == Role.INITIATOR) first else second
        val tx = if (role == Role.INITIATOR) second else first

        return SessionKeys(
            sendKey = tx.copyOf(),
            recvKey = rx.copyOf(),
            resumeAuthKey = resumeAuthKey(tx, rx),
            // NOT sorted, and it must not be: crypto_kx already mirrors tx/rx,
            // so hashing each locally lines the two directions up. Sorting would
            // collapse both onto one key and put two producers on one nonce
            // counter, which is the exact hazard the subkey removes.
            textSendKey = subkey(TEXT_KEY_DOMAIN, tx),
            textRecvKey = subkey(TEXT_KEY_DOMAIN, rx),
        ).also {
            Bytes.wipe(first); Bytes.wipe(second)
        }
    }

    /** `BLAKE2b-256(domain || sessionKey)`. */
    private fun subkey(domain: ByteArray, sessionKey: ByteArray): ByteArray {
        val digest = Blake2bDigest(256)
        digest.update(domain, 0, domain.size)
        digest.update(sessionKey, 0, sessionKey.size)
        val out = ByteArray(SESSION_KEY_BYTES)
        digest.doFinal(out, 0)
        return out
    }

    /**
     * The HMAC key both sides derive to the same value.
     *
     * SORTED, unlike the text subkeys, and for the opposite reason: this key is
     * SHARED, so it has to be symmetric. crypto_kx hands the peers mirrored
     * secrets, so hashing them in local order would give the two ends two
     * different keys; the pair as a SET is identical on both sides.
     */
    private fun resumeAuthKey(tx: ByteArray, rx: ByteArray): ByteArray {
        val first: ByteArray
        val second: ByteArray
        if (Bytes.compare(tx, rx) <= 0) { first = tx; second = rx } else { first = rx; second = tx }
        val digest = Blake2bDigest(256)
        digest.update(RESUME_AUTH_DOMAIN, 0, RESUME_AUTH_DOMAIN.size)
        digest.update(first, 0, first.size)
        digest.update(second, 0, second.size)
        val out = ByteArray(SESSION_KEY_BYTES)
        digest.doFinal(out, 0)
        return out
    }

    // ── AEAD ────────────────────────────────────────────────────────────────

    /**
     * The 12-byte nonce: four zero bytes, then a 64-bit big-endian counter.
     *
     * The counter is the frame's sequence number, so nonce uniqueness under a
     * key is exactly the sequence discipline the lanes enforce — never rewound,
     * never reused, and a resume may only skip FORWARD.
     */
    fun nonceFromSeq(seq: Long): ByteArray {
        require(seq >= 0) { "sequence numbers are non-negative; got $seq" }
        val nonce = ByteArray(AEAD_NONCE_BYTES)
        Bytes.writeUInt32(nonce, 4, (seq ushr 32) and 0xffff_ffffL)
        Bytes.writeUInt32(nonce, 8, seq and 0xffff_ffffL)
        return nonce
    }

    private fun aead(mode: Int, key: SecretKeySpec, seq: Long): Cipher =
        Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, key, GCMParameterSpec(AEAD_TAG_BITS, nonceFromSeq(seq)))
        }

    /** AES-256-GCM, combined mode: the 16-byte tag is appended. No AAD. */
    internal fun seal(key: SecretKeySpec, seq: Long, plaintext: ByteArray): ByteArray =
        aead(Cipher.ENCRYPT_MODE, key, seq).doFinal(plaintext)

    /** The inverse. An authentication failure throws; it is never a soft result. */
    @Throws(GeneralSecurityException::class)
    internal fun open(key: SecretKeySpec, seq: Long, ciphertext: ByteArray): ByteArray =
        aead(Cipher.DECRYPT_MODE, key, seq).doFinal(ciphertext)

    fun sealFile(keys: SessionKeys, seq: Long, plaintext: ByteArray): ByteArray =
        seal(keys.send, seq, plaintext)

    fun openFile(keys: SessionKeys, seq: Long, ciphertext: ByteArray): ByteArray =
        open(keys.recv, seq, ciphertext)

    fun sealText(keys: SessionKeys, seq: Long, plaintext: ByteArray): ByteArray =
        seal(keys.textSend, seq, plaintext)

    fun openText(keys: SessionKeys, seq: Long, ciphertext: ByteArray): ByteArray =
        open(keys.textRecv, seq, ciphertext)

    // ── commitment ──────────────────────────────────────────────────────────

    fun randomCommitNonce(): ByteArray = ByteArray(COMMIT_NONCE_BYTES).also(random::nextBytes)

    /** `BLAKE2b-256(publicKey || nonce)`. */
    fun commitKey(publicKey: ByteArray, nonce: ByteArray): ByteArray {
        val digest = Blake2bDigest(COMMIT_BYTES * 8)
        digest.update(publicKey, 0, publicKey.size)
        digest.update(nonce, 0, nonce.size)
        val out = ByteArray(COMMIT_BYTES)
        digest.doFinal(out, 0)
        return out
    }

    /**
     * Constant-time check that `commit` opens to `(publicKey, nonce)`.
     *
     * False on ANY mismatch, including a short or long commitment. A caller that
     * has no recorded commitment must treat that as a failure too — that check
     * belongs to the handshake state machine, which is where "no commit was ever
     * recorded" is distinguishable from "a commit was recorded and disagreed".
     */
    fun verifyCommit(commit: ByteArray, publicKey: ByteArray, nonce: ByteArray): Boolean {
        if (commit.size != COMMIT_BYTES) return false
        if (publicKey.size != PUBLIC_KEY_BYTES || nonce.size != COMMIT_NONCE_BYTES) return false
        return Bytes.constantTimeEquals(commit, commitKey(publicKey, nonce))
    }

    // ── SAS ─────────────────────────────────────────────────────────────────

    /**
     * The six-digit Short Authentication String.
     *
     * Sort the two raw public keys ascending, `BLAKE2b(8, a || b)`, XOR the two
     * big-endian uint32 halves, take modulo 1 000 000, zero-pad to six.
     *
     * The XOR is UNSIGNED. Reading either half into a signed `Int` and XORing
     * gives a negative value whose Kotlin `%` is also negative, and the code
     * comes out wrong exactly half the time — which a single hand-tested pairing
     * would very likely miss. `crypto-vectors.json` pins `705955`.
     *
     * Six digits, and NOT the pairing code, which is also six digits and
     * unrelated. `relayium-handshake-v1.md` says user-facing copy must never
     * conflate them; `PairCode` and this function deliberately return different
     * types so a UI cannot render one where it meant the other.
     */
    fun sas(selfPublic: ByteArray, peerPublic: ByteArray): String {
        val first: ByteArray
        val second: ByteArray
        if (Bytes.compare(selfPublic, peerPublic) <= 0) {
            first = selfPublic; second = peerPublic
        } else {
            first = peerPublic; second = selfPublic
        }
        val digest = Blake2bDigest(64)
        digest.update(first, 0, first.size)
        digest.update(second, 0, second.size)
        val out = ByteArray(8)
        digest.doFinal(out, 0)
        val hi = Bytes.readUInt32(out, 0)
        val lo = Bytes.readUInt32(out, 4)
        val value = (hi xor lo) % 1_000_000L
        return value.toString().padStart(6, '0')
    }

    // ── signalling tags ─────────────────────────────────────────────────────

    /**
     * `base64(HMAC-SHA-256(resumeAuth, utf8(payload)))`.
     *
     * Standard base64 with padding, so the result is exactly
     * [LinkProtocol.AUTH_TAG_LENGTH] characters — the length a verifier checks
     * before spending any work.
     */
    fun signAuth(keys: SessionKeys, payload: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(keys.resumeAuthKey, "HmacSHA256"))
        return Bytes.base64(mac.doFinal(payload.toByteArray(Charsets.UTF_8)))
    }

    /**
     * Verify a tag. Absent, malformed or wrong-length is **false**, never a
     * throw and never a pass — an "unauthenticated is acceptable" branch would
     * make the whole binding optional at the attacker's choosing.
     */
    fun verifyAuth(keys: SessionKeys, payload: String, tag: String?): Boolean {
        if (tag == null || tag.length != LinkProtocol.AUTH_TAG_LENGTH) return false
        val provided = Bytes.unbase64OrNull(tag) ?: return false
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(keys.resumeAuthKey, "HmacSHA256"))
        return Bytes.constantTimeEquals(provided, mac.doFinal(payload.toByteArray(Charsets.UTF_8)))
    }

    // ── integrity chain ─────────────────────────────────────────────────────

    /**
     * `h = SHA-256(h || chunk)`, starting from 32 zero bytes, over CHUNK_SIZE
     * logical chunks — regardless of how many DataChannel messages carried each
     * one.
     *
     * This is what `DONE_ENC` carries. It is deliberately NOT a plain SHA-256 of
     * the file: `relayium-link-v1.md` section 9.7.
     */
    fun chainStart(): ByteArray = ByteArray(32)

    fun chainAdvance(previous: ByteArray, chunk: ByteArray): ByteArray {
        val sha = MessageDigest.getInstance("SHA-256")
        sha.update(previous)
        sha.update(chunk)
        return sha.digest()
    }
}
