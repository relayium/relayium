package com.relayium.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The crypto layer against `crypto-vectors.json`, the same golden file the Swift
 * port asserts on.
 *
 * These run BEFORE anything opens a socket, which is the point: `crypto_kx` is a
 * composition this module reproduces by hand, and the only thing that can prove
 * the reproduction is byte-correct is a value the browser produced.
 */
class CryptoVectorTest {

    private val v = Fixtures.crypto

    private fun hex(path: String) = Bytes.unhex(Fixtures.str(v, *path.split(".").toTypedArray()))

    private fun alice() = Crypto.KeyPair(hex("alice.pub"), hex("alice.sec"))
    private fun bob() = Crypto.KeyPair(hex("bob.pub"), hex("bob.sec"))

    @Test
    fun `crypto_kx derives both directions, mirrored`() {
        // Alice is the INITIATOR (libsodium's "client"), Bob the RESPONDER
        // ("server"). The mirroring is the property: one side's send key is the
        // other's receive key, with no extra round trip.
        val a = Crypto.deriveSession(Crypto.Role.INITIATOR, alice(), hex("bob.pub"))
        val b = Crypto.deriveSession(Crypto.Role.RESPONDER, bob(), hex("alice.pub"))

        assertEquals(Fixtures.str(v, "session", "aliceSend"), Bytes.hex(a.sendKey))
        assertEquals(Fixtures.str(v, "session", "aliceRecv"), Bytes.hex(a.recvKey))
        assertEquals(Fixtures.str(v, "session", "bobSend"), Bytes.hex(b.sendKey))
        assertEquals(Fixtures.str(v, "session", "bobRecv"), Bytes.hex(b.recvKey))

        assertArrayEquals("alice.send must equal bob.recv", a.sendKey, b.recvKey)
        assertArrayEquals("bob.send must equal alice.recv", b.sendKey, a.recvKey)
    }

    @Test
    fun `swapping the roles produces different keys`() {
        // The hash input is always client_pk then server_pk, and the halves are
        // swapped BY ROLE. A port that hashes "self then peer" passes the
        // mirroring check above by accident and fails here.
        val wrong = Crypto.deriveSession(Crypto.Role.RESPONDER, alice(), hex("bob.pub"))
        assertNotEquals(Fixtures.str(v, "session", "aliceSend"), Bytes.hex(wrong.sendKey))
    }

    @Test
    fun `the SAS is the committed six digits, order-independent`() {
        val expected = Fixtures.str(v, "sas")
        assertEquals(expected, Crypto.sas(hex("alice.pub"), hex("bob.pub")))
        assertEquals(
            "the two public keys are sorted before hashing, so order cannot matter",
            expected, Crypto.sas(hex("bob.pub"), hex("alice.pub")),
        )
        assertEquals(6, expected.length)
    }

    @Test
    fun `the SAS XOR is unsigned`() {
        // Reading either half into a signed Int and XORing gives a negative
        // value whose Kotlin `%` is also negative, so the code comes out wrong
        // for about half of all key pairs. The committed vector is one of the
        // pairs that would expose it; this states the property directly too.
        repeat(64) {
            val x = Crypto.generateKeyPair()
            val y = Crypto.generateKeyPair()
            val sas = Crypto.sas(x.publicKey, y.publicKey)
            assertEquals(6, sas.length)
            assertTrue("a SAS is six decimal digits, got $sas", sas.all { c -> c in '0'..'9' })
        }
    }

    @Test
    fun `the commitment reproduces and verifies`() {
        val nonce = hex("commit.nonce")
        val expected = Fixtures.str(v, "commit", "value")
        assertEquals(expected, Bytes.hex(Crypto.commitKey(hex("alice.pub"), nonce)))
        assertTrue(Crypto.verifyCommit(Bytes.unhex(expected), hex("alice.pub"), nonce))
    }

    @Test
    fun `a commitment refuses every wrong input`() {
        val nonce = hex("commit.nonce")
        val commit = Bytes.unhex(Fixtures.str(v, "commit", "value"))
        assertFalse("wrong public key", Crypto.verifyCommit(commit, hex("bob.pub"), nonce))
        assertFalse("wrong nonce", Crypto.verifyCommit(commit, hex("alice.pub"), ByteArray(32)))
        assertFalse("short commitment", Crypto.verifyCommit(commit.copyOf(31), hex("alice.pub"), nonce))
        assertFalse("long commitment", Crypto.verifyCommit(commit + 0, hex("alice.pub"), nonce))
        assertFalse("empty commitment", Crypto.verifyCommit(ByteArray(0), hex("alice.pub"), nonce))
        assertFalse(
            "a public key of the wrong length",
            Crypto.verifyCommit(commit, hex("alice.pub").copyOf(31), nonce),
        )
    }

    @Test
    fun `AEAD reproduces the committed ciphertext at a non-zero sequence`() {
        val key = javax.crypto.spec.SecretKeySpec(hex("aead.keyHex"), "AES")
        val seq = Fixtures.num(v, "aead", "seq")
        val plaintext = hex("aead.ptHex")
        val expected = Fixtures.str(v, "aead", "ctHex")
        assertEquals(expected, Bytes.hex(Crypto.seal(key, seq, plaintext)))
        assertArrayEquals(
            "and it opens back to the same plaintext",
            plaintext, Crypto.open(key, seq, Bytes.unhex(expected)),
        )
    }

    @Test
    fun `the AEAD nonce is four zero bytes then a big-endian counter`() {
        assertEquals("000000000000000000000000", Bytes.hex(Crypto.nonceFromSeq(0)))
        assertEquals("000000000000000000000005", Bytes.hex(Crypto.nonceFromSeq(5)))
        assertEquals("00000000000000ffffffffff", Bytes.hex(Crypto.nonceFromSeq(0xffffffffffL)))
        // The counter is 64 bits wide even though the WIRE field is 32, so the
        // schedule is the same one the stored-wire layer uses.
        assertEquals("000000000000000100000000", Bytes.hex(Crypto.nonceFromSeq(1L shl 32)))
    }

    @Test
    fun `opening with the wrong sequence number fails`() {
        val key = javax.crypto.spec.SecretKeySpec(hex("aead.keyHex"), "AES")
        val ct = hex("aead.ctHex")
        val wrongSeq = Fixtures.num(v, "aead", "seq") + 1
        val failure = runCatching { Crypto.open(key, wrongSeq, ct) }.exceptionOrNull()
        assertTrue(
            "the sequence is IN the nonce, so a rewritten header is an auth failure",
            failure is java.security.GeneralSecurityException,
        )
    }

    @Test
    fun `the resume-auth key still produces the committed MAC`() {
        // deriveSession's resume-auth key is not exported, so it is pinned
        // transitively: derive a session from the fixture keypairs, sign the
        // fixture payload, and require the committed tag.
        val keys = Crypto.deriveSession(Crypto.Role.INITIATOR, alice(), hex("bob.pub"))
        val payload = Fixtures.str(v, "resumeAuth", "payload")
        val mac = Fixtures.str(v, "resumeAuth", "mac")
        assertEquals(Fixtures.str(v, "resumeAuth", "keyHex"), Bytes.hex(keys.resumeAuthKey))
        assertEquals(mac, Crypto.signAuth(keys, payload))
        assertTrue(Crypto.verifyAuth(keys, payload, mac))
        assertEquals("standard padded base64 is exactly 44 characters", 44, mac.length)
    }

    @Test
    fun `both sides derive the SAME resume-auth key`() {
        val a = Crypto.deriveSession(Crypto.Role.INITIATOR, alice(), hex("bob.pub"))
        val b = Crypto.deriveSession(Crypto.Role.RESPONDER, bob(), hex("alice.pub"))
        assertArrayEquals(
            "the inputs are SORTED, which is what makes this key symmetric",
            a.resumeAuthKey, b.resumeAuthKey,
        )
    }

    @Test
    fun `a malformed or absent tag is a refusal, never a throw`() {
        val keys = Crypto.deriveSession(Crypto.Role.INITIATOR, alice(), hex("bob.pub"))
        assertFalse(Crypto.verifyAuth(keys, "p", null))
        assertFalse(Crypto.verifyAuth(keys, "p", ""))
        assertFalse(Crypto.verifyAuth(keys, "p", "!".repeat(44)))
        assertFalse("wrong length is refused before any decode", Crypto.verifyAuth(keys, "p", "AAAA"))
    }

    @Test
    fun `text subkeys are per direction and NOT sorted`() {
        val a = Crypto.deriveSession(Crypto.Role.INITIATOR, alice(), hex("bob.pub"))
        val b = Crypto.deriveSession(Crypto.Role.RESPONDER, bob(), hex("alice.pub"))
        assertEquals(Fixtures.str(v, "textKeys", "aliceTextSend"), Bytes.hex(a.textSendKey))
        assertEquals(Fixtures.str(v, "textKeys", "aliceTextRecv"), Bytes.hex(a.textRecvKey))
        assertEquals(Fixtures.str(v, "textKeys", "bobTextSend"), Bytes.hex(b.textSendKey))
        assertEquals(Fixtures.str(v, "textKeys", "bobTextRecv"), Bytes.hex(b.textRecvKey))
        assertArrayEquals(a.textSendKey, b.textRecvKey)
        assertNotEquals(
            "sorting would collapse the two directions onto one key",
            Bytes.hex(a.textSendKey), Bytes.hex(a.textRecvKey),
        )
    }

    @Test
    fun `the text key domain is seventeen bytes including the NUL`() {
        val committed = Fixtures.str(v, "textKeys", "domain")
        assertEquals(
            "the fixture's own domain string must be what this module uses",
            committed, String(Crypto.TEXT_KEY_DOMAIN, Charsets.US_ASCII),
        )
        assertEquals(17, Crypto.TEXT_KEY_DOMAIN.size)
        assertEquals("the last byte is a NUL", 0, Crypto.TEXT_KEY_DOMAIN.last().toInt())
        assertEquals(24, Crypto.RESUME_AUTH_DOMAIN.size)
    }

    // ── adversarial key agreement ───────────────────────────────────────────

    @Test
    fun `an all-zero peer public key is refused`() {
        val failure = runCatching {
            Crypto.deriveSession(Crypto.Role.INITIATOR, alice(), ByteArray(32))
        }.exceptionOrNull()
        assertTrue(
            "an all-zero agreement gives both ends a secret an attacker also knows",
            failure is Crypto.LowOrderKeyException,
        )
    }

    @Test
    fun `libsodium's small-order blocklist is refused, and its high-bit aliases too`() {
        // The expected dangerous-key set comes from UPSTREAM, not from probing
        // what the local X25519 happens to reject: libsodium's
        // crypto_scalarmult/curve25519/ref10/x25519_ref10.c `has_small_order`
        // asserts exactly SEVEN entries — 0, 1, the two torsion points
        // 325606250916557431795983626356110631294008115727848805560023387167927233504 (e0eb…b800)
        // and 39382357235489614581723060781553021112529911719440698176882885853963445705823 (5f9c…1157),
        // then p-1, p and p+1 — and masks the input's high bit before comparing.
        // (A frequently-quoted eighth value, cdeb…b880, is NOT in that list and
        // yields a real non-zero secret; asserting it would pin folklore.)
        val blocklist = listOf(
            "0000000000000000000000000000000000000000000000000000000000000000", // 0
            "0100000000000000000000000000000000000000000000000000000000000000", // 1
            "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", // torsion
            "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157", // torsion
            "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p-1
            "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p
            "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p+1
        )
        for (hexPoint in blocklist) {
            val point = Bytes.unhex(hexPoint)
            val failure = runCatching {
                Crypto.deriveSession(Crypto.Role.INITIATOR, alice(), point)
            }.exceptionOrNull()
            assertTrue("peer key $hexPoint must be refused", failure is Crypto.LowOrderKeyException)

            // RFC 7748 masks bit 255 of the u-coordinate before the ladder, so
            // the high-bit alias of each point is the SAME point and must be
            // refused identically — which is why libsodium's own comparison
            // masks the final byte with 0x7f.
            val alias = point.copyOf().also { it[31] = (it[31].toInt() or 0x80).toByte() }
            val aliasFailure = runCatching {
                Crypto.deriveSession(Crypto.Role.INITIATOR, alice(), alias)
            }.exceptionOrNull()
            assertTrue(
                "the high-bit alias of $hexPoint must be refused too",
                aliasFailure is Crypto.LowOrderKeyException,
            )
        }
        // And the refusal is not indiscriminate: an ordinary key still agrees.
        Crypto.deriveSession(Crypto.Role.INITIATOR, alice(), hex("bob.pub"))
    }

    @Test
    fun `a peer public key of the wrong length is refused before any agreement`() {
        for (size in listOf(0, 31, 33, 64)) {
            val failure = runCatching {
                Crypto.deriveSession(Crypto.Role.INITIATOR, alice(), ByteArray(size))
            }.exceptionOrNull()
            assertTrue("a $size-byte key must be refused", failure is IllegalArgumentException)
        }
    }

    private fun assertArrayEquals(message: String, expected: ByteArray, actual: ByteArray) {
        assertTrue("$message: ${Bytes.hex(expected)} != ${Bytes.hex(actual)}", expected.contentEquals(actual))
    }

    private fun assertArrayEquals(expected: ByteArray, actual: ByteArray) =
        assertArrayEquals("arrays differ", expected, actual)
}
