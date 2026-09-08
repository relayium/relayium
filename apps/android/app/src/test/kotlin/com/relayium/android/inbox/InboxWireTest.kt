package com.relayium.android.inbox

import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxAutoAccept
import com.relayium.protocol.inbox.InboxCentralErrorCode
import com.relayium.protocol.inbox.InboxDeviceErrorCode
import com.relayium.protocol.inbox.InboxPresence
import com.relayium.protocol.inbox.InboxProtocol
import com.relayium.protocol.inbox.InboxTaskErrorCode
import com.relayium.protocol.inbox.InboxTaskState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The strict decoders, driven by documents that are wrong in one exact way.
 *
 * The point of every negative case here is that the WRONG answer is available
 * and plausible. A permissive reader would resolve an unknown state to some
 * member, read `"true"` as true, and turn `1.5` into `1` — each of which is this
 * build inventing a fact about the server rather than failing to parse one.
 */
class InboxWireTest {

    private fun refusal(body: () -> Unit): InboxWireException =
        try {
            body()
            throw AssertionError("expected a wire refusal")
        } catch (e: InboxWireException) {
            e
        }

    // ── the happy shapes ────────────────────────────────────────────────────

    @Test
    fun `a device row decodes every field the sender needs`() {
        val row = InboxDeviceRow.read(InboxFixtures.device())
        assertEquals(InboxFixtures.DEVICE_ID, row.id)
        assertTrue(row.isCurrent)
        val inbox = requireNotNull(row.inbox) { "inbox subtree" }
        assertEquals(InboxPresence.ONLINE, inbox.presence)
        assertEquals(InboxAutoAccept.AUTO, inbox.autoAccept)
        assertTrue(inbox.canReceive)
        assertEquals(InboxFixtures.KEY_ID, inbox.key?.id)
        assertTrue(inbox.key!!.isActive)
    }

    /** A device that never enrolled is a legitimate row, not a malformed one. */
    @Test
    fun `an omitted inbox subtree is a device that never enrolled`() {
        assertNull(InboxDeviceRow.read(InboxFixtures.device("Inbox" to null)).inbox)
        assertNotNull(InboxDeviceRow.read(InboxFixtures.device()).inbox)
    }

    /** An enrolment with no active key is likewise legitimate: the device is
     *  enrolled and has not published one yet. */
    @Test
    fun `an enrolment may carry no active key`() {
        assertNull(
            InboxEnrolmentView.read(InboxFixtures.enrolment("Key" to null)).key,
        )
    }

    /**
     * The sharp negative case for an optional. Reading a wrong-typed `Key` as
     * absent would turn a malformed reply into a confident "this device holds no
     * key" — the exact input that drives key health and the explicit repair
     * offer, so the app would propose repairing custody that is not broken.
     */
    @Test
    fun `a wrong-typed key is refused rather than read as absent`() {
        for (bad in listOf(Json.of("key"), Json.arr(listOf()), Json.of(true), Json.of(1L))) {
            val e = refusal { InboxEnrolmentView.read(InboxFixtures.enrolment("Key" to bad)) }
            assertEquals(InboxWireReason.WRONG_TYPE, e.reason)
            assertEquals("Key", e.field)
        }
    }

    @Test
    fun `a wrong-typed inbox subtree is refused rather than read as not enrolled`() {
        for (bad in listOf(Json.of("inbox"), Json.arr(listOf()), Json.of(false))) {
            val e = refusal { InboxDeviceRow.read(InboxFixtures.device("Inbox" to bad)) }
            assertEquals(InboxWireReason.WRONG_TYPE, e.reason)
            assertEquals("Inbox", e.field)
        }
    }

    /**
     * An explicit JSON null is the server saying "there is none", which the Go
     * encoder writes for a nil pointer — so both spellings must read as absent,
     * and only a wrong TYPE may be refused.
     */
    @Test
    fun `an explicit null optional is absent, not malformed`() {
        assertNull(InboxEnrolmentView.read(InboxFixtures.enrolment("Key" to Json.Null)).key)
        assertNull(InboxDeviceRow.read(InboxFixtures.device("Inbox" to Json.Null)).inbox)
    }

    /**
     * An algorithm this build does not know stays REPRESENTABLE. It is not a
     * decode failure: the row is well-formed, and refusing the whole device list
     * over one future algorithm would hide every other device on the account.
     * The refusal belongs to eligibility, which reports it as an unsupported
     * key the user can be told about.
     */
    @Test
    fun `an unknown key algorithm decodes and is refused later, by eligibility`() {
        val key = InboxKeyRow.read(InboxFixtures.key("Algorithm" to Json.of("pq-kem-v9")))
        assertEquals("pq-kem-v9", key.algorithm)
        val row = InboxDeviceRow.read(
            InboxFixtures.device(
                "Inbox" to InboxFixtures.enrolment(
                    "Key" to InboxFixtures.key("Algorithm" to Json.of("pq-kem-v9")),
                ),
            ),
        )
        assertEquals(
            InboxTargetBlock.UNSUPPORTED_KEY,
            InboxTargetEligibility.availability(row).block,
        )
    }

    @Test
    fun `a superseded key is inactive but still readable`() {
        val key = InboxKeyRow.read(InboxFixtures.key("SupersededAt" to Json.of(1_700_000_500L)))
        assertFalse(key.isActive)
        val revoked = InboxKeyRow.read(InboxFixtures.key("RevokedAt" to Json.of(1_700_000_500L)))
        assertFalse(revoked.isActive)
    }

    @Test
    fun `a delivery carries the claim material and redacts itself`() {
        val delivery = InboxDelivery.read(InboxFixtures.delivery())
        assertEquals(InboxFixtures.TASK_ID, delivery.task.id)
        assertEquals("claim-token-value", delivery.claimToken)
        assertFalse(
            "a claim token must not reach a diagnostic",
            delivery.toString().contains("claim-token-value"),
        )
        assertFalse(delivery.toString().contains(delivery.wrappedKey))
    }

    /** Central authors codes a device may never submit; a READ model has to
     *  accept them, which is why the union type exists. */
    @Test
    fun `a task may carry a central-authored error code`() {
        val task = InboxTaskRow.read(InboxFixtures.task("ErrorCode" to Json.of("lease_expired")))
        assertEquals(
            InboxTaskErrorCode.Central(InboxCentralErrorCode.LEASE_EXPIRED),
            task.errorCode,
        )
        val device = InboxTaskRow.read(InboxFixtures.task("ErrorCode" to Json.of("disk_full")))
        assertEquals(InboxTaskErrorCode.Device(InboxDeviceErrorCode.DISK_FULL), device.errorCode)
        assertTrue(InboxTaskRow.read(InboxFixtures.task()).errorCode.isNone)
    }

    // ── closed sets fail closed ─────────────────────────────────────────────

    @Test
    fun `an unknown task state is refused rather than defaulted`() {
        val e = refusal { InboxTaskRow.read(InboxFixtures.task("State" to Json.of("teleporting"))) }
        assertEquals(InboxWireReason.UNKNOWN_VALUE, e.reason)
        assertEquals("State", e.field)
    }

    @Test
    fun `an unknown receive policy is refused rather than read as off`() {
        val e = refusal {
            InboxEnrolmentView.read(InboxFixtures.enrolment("AutoAccept" to Json.of("sometimes")))
        }
        assertEquals(InboxWireReason.UNKNOWN_VALUE, e.reason)
        // `off` is the safe member, which is exactly why resolving to it would
        // be wrong: it would silently disable a device whose real policy the
        // server named and this build failed to read.
        assertEquals("AutoAccept", e.field)
    }

    @Test
    fun `an unknown presence is refused rather than read as offline`() {
        val e = refusal {
            InboxEnrolmentView.read(InboxFixtures.enrolment("Presence" to Json.of("away")))
        }
        assertEquals(InboxWireReason.UNKNOWN_VALUE, e.reason)
    }

    @Test
    fun `an unknown error code is refused`() {
        val e = refusal {
            InboxTaskRow.read(InboxFixtures.task("ErrorCode" to Json.of("cosmic_rays")))
        }
        assertEquals(InboxWireReason.UNKNOWN_VALUE, e.reason)
    }

    // ── types are types ─────────────────────────────────────────────────────

    @Test
    fun `a truthy string is not a boolean`() {
        for (value in listOf(Json.of("true"), Json.of(1L), Json.of("1"))) {
            val e = refusal {
                InboxEnrolmentView.read(InboxFixtures.enrolment("CanReceive" to value))
            }
            assertEquals(InboxWireReason.WRONG_TYPE, e.reason)
            assertEquals("CanReceive", e.field)
        }
    }

    @Test
    fun `a missing field is named as missing`() {
        val e = refusal { InboxTaskRow.read(InboxFixtures.task("State" to null)) }
        assertEquals(InboxWireReason.MISSING_FIELD, e.reason)
        assertEquals("State", e.field)
    }

    // ── numbers ─────────────────────────────────────────────────────────────

    /**
     * The sharp one. `Double.toLong()` truncates, so a fractional byte count
     * would become a neighbouring integer and be used to preflight disk space
     * and to bound a manifest — silently, and with no failure anywhere.
     */
    @Test
    fun `a fractional number is refused rather than truncated`() {
        val e = refusal {
            InboxTaskRow.read(
                InboxFixtures.task("CiphertextBytes" to Json.Num(4096.5)),
            )
        }
        assertEquals(InboxWireReason.OUT_OF_RANGE, e.reason)
        assertEquals("CiphertextBytes", e.field)
    }

    @Test
    fun `a number beyond the lossless range is refused rather than clamped`() {
        for (value in listOf(1e30, -1e30, Double.NaN, Double.POSITIVE_INFINITY)) {
            val e = refusal {
                InboxTaskRow.read(InboxFixtures.task("CiphertextBytes" to Json.Num(value)))
            }
            assertEquals(InboxWireReason.OUT_OF_RANGE, e.reason)
        }
    }

    @Test
    fun `a negative timestamp is refused`() {
        val e = refusal { InboxTaskRow.read(InboxFixtures.task("SavedAt" to Json.of(-1L))) }
        assertEquals(InboxWireReason.OUT_OF_RANGE, e.reason)
    }

    /** A generation of zero would make "which key is newer" unanswerable, and
     *  the server never mints one. */
    @Test
    fun `a key generation below one is refused`() {
        val e = refusal { InboxKeyRow.read(InboxFixtures.key("Generation" to Json.of(0L))) }
        assertEquals(InboxWireReason.OUT_OF_RANGE, e.reason)
        assertEquals("Generation", e.field)
    }

    @Test
    fun `the exact lossless integer boundary is accepted`() {
        val task = InboxTaskRow.read(
            InboxFixtures.task("ExpiresAt" to Json.of(Wire.MAX_SAFE_INTEGER)),
        )
        assertEquals(Wire.MAX_SAFE_INTEGER, task.expiresAt)
    }

    // ── identifiers ─────────────────────────────────────────────────────────

    @Test
    fun `an identifier that would escape its path segment is refused`() {
        for (bad in listOf("../../admin", "a/b", "", "with space", "x".repeat(65))) {
            val e = refusal { InboxTaskRow.read(InboxFixtures.task("ID" to Json.of(bad))) }
            assertTrue(
                "unexpected reason for '$bad': ${e.reason}",
                e.reason == InboxWireReason.INVALID_IDENTIFIER ||
                    e.reason == InboxWireReason.MISSING_FIELD,
            )
        }
        assertTrue(InboxId.isValid(InboxFixtures.TASK_ID))
    }

    // ── the terminal flag ───────────────────────────────────────────────────

    /**
     * The state is what the transition table is written against, so a `saved`
     * row arriving with `Terminal:false` is still terminal. Preferring the flag
     * would let a server bug re-open a delivery that already landed.
     */
    @Test
    fun `a terminal state wins over a false terminal flag`() {
        val task = InboxTaskRow.read(
            InboxFixtures.task("State" to Json.of("saved"), "Terminal" to Json.of(false)),
        )
        assertEquals(InboxTaskState.SAVED, task.state)
        assertTrue(task.isTerminal)
    }

    @Test
    fun `a terminal flag alone still marks a non-terminal state terminal`() {
        val task = InboxTaskRow.read(
            InboxFixtures.task("State" to Json.of("queued"), "Terminal" to Json.of(true)),
        )
        assertTrue(task.isTerminal)
    }

    // ── content range ───────────────────────────────────────────────────────

    @Test
    fun `a well-formed content range parses`() {
        val range = InboxContentRange.of("bytes 4096-8191/8192")
        assertEquals(InboxContentRange(4096, 8191, 8192), range)
        assertEquals(4096L, range!!.length)
        // The server writes exactly this shape; a single trailing space is the
        // only slack worth having, and it is handled by trimming.
        assertEquals(range, InboxContentRange.of("  bytes 4096-8191/8192 "))
    }

    /**
     * The lenient-parser hazard, case by case.
     *
     * Each of these would yield a confident `start` under a `substringBefore('-')`
     * reading, and the consequence is not a parse error later: it is the wrong
     * region of an object spliced into the middle of an authenticated stream,
     * where every frame still verifies because every frame really is the
     * sender's.
     */
    @Test
    fun `a malformed content range is refused rather than half-read`() {
        val malformed = listOf(
            "bytes 32-garbage/64",   // an end that is not a number
            "bytes 32",              // no dash, no end, no total
            "bytes 32-64",           // no total
            "bytes 32/64",           // no dash
            "bytes -64/128",         // no start
            "bytes 32-/128",         // no end
            "bytes 32-64/",          // no total value
            "bytes 32-64/128/256",   // two totals
            "bytes 32-64-96/128",    // two dashes
            "bytes 64-32/128",       // start after end
            "bytes 32-128/128",      // end not inside total
            "bytes 32-64/*",         // unknown total: this server never sends one
            "bytes +32-64/128",      // signed
            "bytes -32--16/128",     // negative
            "items 32-64/128",       // not a byte range
            "32-64/128",             // no unit
            "",
            "bytes 99999999999999999999-99999999999999999999/99999999999999999999",
        )
        for (header in malformed) {
            assertNull("accepted '$header'", InboxContentRange.of(header))
        }
        assertNull(InboxContentRange.of(null))
    }

    /** A value past the lossless integer range is refused rather than wrapped. */
    @Test
    fun `a content range beyond the lossless range is refused`() {
        val tooLarge = Wire.MAX_SAFE_INTEGER + 1
        assertNull(InboxContentRange.of("bytes 0-$tooLarge/${tooLarge + 1}"))
        assertEquals(
            InboxContentRange(0, Wire.MAX_SAFE_INTEGER - 1, Wire.MAX_SAFE_INTEGER),
            InboxContentRange.of("bytes 0-${Wire.MAX_SAFE_INTEGER - 1}/${Wire.MAX_SAFE_INTEGER}"),
        )
    }

    // ── the create request ──────────────────────────────────────────────────

    @Test
    fun `a send request carries exactly seven keys and no content description`() {
        val payload = InboxSendRequest(
            idempotencyKey = "idem-1",
            storedFileId = InboxFixtures.STORED_ID,
            wrappedKey = InboxFixtures.wrappedKey(),
            targetKeyId = InboxFixtures.KEY_ID,
            targetKeyGeneration = 1,
        ).payload()
        assertEquals(
            setOf(
                "idempotencyKey", "storedFileId", "protocolVersion",
                "wrapAlgorithm", "wrappedKey", "targetKeyId", "targetKeyGeneration",
            ),
            payload.entries.keys,
        )
        assertEquals(
            Json.of(InboxProtocol.TASK_PROTOCOL_VERSION),
            payload["protocolVersion"],
        )
        for (forbidden in listOf("kind", "name", "text", "path", "contentKey", "privateKey")) {
            assertNull("a create must never describe its content", payload[forbidden])
        }
    }

    @Test
    fun `a malformed wrapped key is refused before any upload`() {
        val tooShort = com.relayium.protocol.inbox.InboxKeyMaterial.encode(ByteArray(16))
        assertRejected { InboxSendRequest("idem", InboxFixtures.STORED_ID, tooShort, InboxFixtures.KEY_ID, 1) }
        assertRejected { InboxSendRequest("idem", InboxFixtures.STORED_ID, "not base64url!!", InboxFixtures.KEY_ID, 1) }
    }

    @Test
    fun `a non-positive key generation is refused`() {
        assertRejected {
            InboxSendRequest("idem", InboxFixtures.STORED_ID, InboxFixtures.wrappedKey(), InboxFixtures.KEY_ID, 0)
        }
    }

    @Test
    fun `an idempotency key is bounded in BYTES not characters`() {
        assertTrue(InboxSendRequest.isValidIdempotencyKey("a".repeat(128)))
        assertFalse(InboxSendRequest.isValidIdempotencyKey("a".repeat(129)))
        assertFalse(InboxSendRequest.isValidIdempotencyKey(""))
        assertFalse(InboxSendRequest.isValidIdempotencyKey("has space"))
        assertFalse(InboxSendRequest.isValidIdempotencyKey("tab\there"))
        // 64 multi-byte scalars are 128 characters' worth of BYTES at the limit,
        // and 65 exceed it — a per-character check would accept both.
        assertFalse(InboxSendRequest.isValidIdempotencyKey("é".repeat(65)))
    }

    private fun assertRejected(body: () -> Unit) {
        try {
            body()
            throw AssertionError("expected the request to be refused")
        } catch (_: IllegalArgumentException) {
            // expected
        } catch (_: InboxWireException) {
            // an identifier refusal is equally a refusal before the wire
        }
    }
}
