package com.relayium.protocol.inbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The vocabulary, asserted as the closed sets it claims to be.
 *
 * Every case here is a fail-closed one: a token this build does not know must
 * come back as null, not as a default. The tokens themselves are written out
 * rather than derived, because they ARE the contract with
 * `server/internal/inbox` and with RelayiumKit — a test that generated them from
 * the enums would agree with any spelling this file happened to have.
 */
class InboxProtocolTest {

    // ── versions ────────────────────────────────────────────────────────────

    @Test
    fun `only v3 is spoken, and an unknown version never degrades to a default`() {
        assertEquals(listOf(3), InboxProtocol.VERSIONS)
        assertEquals(3, InboxProtocol.TASK_PROTOCOL_VERSION)
        for (version in listOf(0, 1, 2, 4, -1)) assertFalse(InboxProtocol.isSupportedVersion(version))
        assertTrue(InboxProtocol.isSupportedVersion(3))

        // Highest common, and no fallback: a central offering only the retired
        // versions is one this build refuses to enrol with.
        assertEquals(3, InboxProtocol.negotiateProtocolVersion(listOf(1, 2, 3)))
        assertEquals(3, InboxProtocol.negotiateProtocolVersion(listOf(3, 4)))
        assertNull(InboxProtocol.negotiateProtocolVersion(listOf(1, 2)))
        assertNull(InboxProtocol.negotiateProtocolVersion(emptyList()))
        assertNull(InboxProtocol.negotiateProtocolVersion(List(17) { 3 }))
    }

    @Test
    fun `a task create declares a version central would accept, and 0 is not one`() {
        // 0 is the zero value of an omitted JSON field, so it must be refused
        // like any other unknown version rather than read as "current".
        for (version in listOf(0, 1, 2, 4)) assertFalse(InboxProtocol.isValidTaskProtocolVersion(version))
        assertTrue(InboxProtocol.isValidTaskProtocolVersion(3))
    }

    // ── key material sizes ──────────────────────────────────────────────────

    @Test
    fun `the wrapped key has one exact length, in layout order`() {
        assertEquals("x25519-sealedbox-v1", InboxProtocol.KEY_ALGORITHM)
        assertEquals(32, InboxProtocol.PUBLIC_KEY_BYTES)
        assertEquals(32, InboxProtocol.CONTENT_KEY_BYTES)
        assertEquals(16, InboxProtocol.POLY1305_TAG_BYTES)
        assertEquals(80, InboxProtocol.SEALED_BOX_BYTES)
    }

    // ── capabilities ────────────────────────────────────────────────────────

    @Test
    fun `capability tokens carry a mandatory version with one spelling`() {
        for (token in listOf(
            InboxCapability.RECEIVE_V1, InboxCapability.RECEIVE_V2, InboxCapability.RECEIVE_V3,
            InboxCapability.TEXT_V1, InboxCapability.AUTO_ACCEPT_V1, InboxCapability.RESUME_V1,
            "a.v1", "a.b.c.v12", "x".repeat(60) + ".v1",
        )) {
            assertTrue(token, InboxProtocol.isValidCapabilityToken(token))
        }
        for (token in listOf(
            "", "inbox", "inbox.receive", "inbox.receive.v0", "inbox.receive.v01",
            "inbox.receive.vx", "inbox.receive.1", "Inbox.receive.v1", "inbox..v1",
            ".v1", "inbox.receive.v1 ", "inbox.re-ceive.v1", "x".repeat(65) + ".v1",
        )) {
            assertFalse(token, InboxProtocol.isValidCapabilityToken(token))
        }
        assertEquals("inbox.receive.v3", InboxCapability.REQUIRED_RECEIVE)
    }

    @Test
    fun `the announced set is deduplicated and sorted, and unknown tokens survive`() {
        // Central relays what it does not understand; dropping a token locally
        // would hide a capability from a sender that does understand it.
        assertEquals(
            listOf("inbox.autoaccept.v1", "inbox.receive.v3", "something.new.v9"),
            InboxProtocol.canonicalCapabilities(
                listOf("something.new.v9", "inbox.receive.v3", "inbox.autoaccept.v1", "inbox.receive.v3"),
            ),
        )
        assertEquals(emptyList<String>(), InboxProtocol.canonicalCapabilities(emptyList()))
        assertNull(InboxProtocol.canonicalCapabilities(listOf("inbox.receive.v3", "bad")))
        assertNull(InboxProtocol.canonicalCapabilities(List(33) { "a.v$it" }))
    }

    // ── policies and presence ───────────────────────────────────────────────

    @Test
    fun `an unspecified auto-accept policy is off, and an unknown one is nothing`() {
        assertEquals(InboxAutoAccept.OFF, InboxAutoAccept.fromWire(""))
        assertEquals(InboxAutoAccept.AUTO, InboxAutoAccept.fromWire("auto"))
        for (value in listOf("on", "Auto", "AUTO", "always", " auto")) {
            assertNull(value, InboxAutoAccept.fromWire(value))
        }
        assertEquals(listOf("off", "ask", "auto"), InboxAutoAccept.entries.map { it.wire })
    }

    @Test
    fun `presence has exactly two values and no unknown`() {
        assertEquals(listOf("online", "offline"), InboxPresence.entries.map { it.wire })
        assertNull(InboxPresence.fromWire("unknown"))
        assertNull(InboxPresence.fromWire(""))
        assertEquals(90, InboxProtocol.PRESENCE_TTL_SECONDS)
        assertEquals(30, InboxProtocol.DEFAULT_HEARTBEAT_SECONDS)
    }

    // ── task states ─────────────────────────────────────────────────────────

    @Test
    fun `the task state set is exactly central's`() {
        assertEquals(
            listOf(
                "queued", "notified", "downloading", "verifying", "saved",
                "attention_required", "expired", "revoked",
                "failed_retryable", "failed_terminal",
            ),
            InboxTaskState.entries.map { it.wire },
        )
        assertEquals(
            setOf(
                InboxTaskState.SAVED, InboxTaskState.EXPIRED,
                InboxTaskState.REVOKED, InboxTaskState.FAILED_TERMINAL,
            ),
            InboxTaskState.entries.filter { it.isTerminal }.toSet(),
        )
        // Narrower than central's transition table on purpose: a device that
        // could report `queued` could reset its own backoff, and one that could
        // report `expired` could forge central's judgement about time.
        assertEquals(
            setOf(
                InboxTaskState.DOWNLOADING, InboxTaskState.VERIFYING, InboxTaskState.SAVED,
                InboxTaskState.ATTENTION_REQUIRED, InboxTaskState.FAILED_RETRYABLE,
                InboxTaskState.FAILED_TERMINAL,
            ),
            InboxTaskState.entries.filter { it.isDeviceReportable }.toSet(),
        )
    }

    @Test
    fun `the sender-local phases are named so they can be refused by name`() {
        for (value in listOf(InboxSenderLocalState.ENCRYPTING, InboxSenderLocalState.UPLOADING)) {
            assertTrue(InboxSenderLocalState.isSenderLocal(value))
            // Real product states central must never store, so they are not
            // task states here either.
            assertNull(value, InboxTaskState.fromWire(value))
        }
        assertFalse(InboxSenderLocalState.isSenderLocal("queued"))
    }

    // ── error codes ─────────────────────────────────────────────────────────

    @Test
    fun `a device may not submit central's own codes`() {
        assertEquals("", InboxDeviceErrorCode.NONE.wire)
        assertEquals(InboxDeviceErrorCode.NONE, InboxDeviceErrorCode.fromWire(""))
        assertEquals(InboxDeviceErrorCode.DISK_FULL, InboxDeviceErrorCode.fromWire("disk_full"))
        // The whole split: these are readable on a row and unsayable by a device.
        for (code in InboxCentralErrorCode.entries) {
            assertNull(code.wire, InboxDeviceErrorCode.fromWire(code.wire))
            assertEquals(
                InboxTaskErrorCode.Central(code),
                InboxTaskErrorCode.fromWire(code.wire),
            )
        }
        assertNull(InboxDeviceErrorCode.fromWire("boom"))
        assertNull(InboxCentralErrorCode.fromWire("disk_full"))
    }

    @Test
    fun `the read model unions both authors and still refuses an unknown token`() {
        assertEquals(
            InboxTaskErrorCode.Device(InboxDeviceErrorCode.VERIFY_FAILED),
            InboxTaskErrorCode.fromWire("verify_failed"),
        )
        assertTrue(InboxTaskErrorCode.fromWire("")!!.isNone)
        assertFalse(InboxTaskErrorCode.fromWire("lease_expired")!!.isNone)
        assertEquals("lease_expired", InboxTaskErrorCode.fromWire("lease_expired")!!.wire)
        assertNull(InboxTaskErrorCode.fromWire("something_new"))
    }

    @Test
    fun `rejections a client must branch on are named, and nothing else is`() {
        for (rejection in InboxRejection.entries) {
            assertEquals(rejection, InboxRejection.fromWire(rejection.wire))
        }
        assertEquals(InboxRejection.STALE_TARGET_KEY, InboxRejection.fromWire("stale_target_key"))
        assertNull(InboxRejection.fromWire("rate_limited"))
        assertNull(InboxRejection.fromWire(""))
    }

    // ── announce bounds ─────────────────────────────────────────────────────

    @Test
    fun `the self-description a device announces is bounded`() {
        assertTrue(InboxProtocol.isValidPlatform("android"))
        assertTrue(InboxProtocol.isValidPlatform(""))
        assertFalse(InboxProtocol.isValidPlatform("a".repeat(33)))
        assertFalse(InboxProtocol.isValidPlatform("android\n"))
        assertFalse(InboxProtocol.isValidPlatform("安卓"))
        assertTrue(InboxProtocol.isValidAppVersion("0.1.1 (2)"))
        assertFalse(InboxProtocol.isValidAppVersion("a".repeat(65)))
        assertEquals(1, InboxProtocol.CLAIM_BATCH)
        assertEquals("X-Relayium-Inbox-Claim", InboxProtocol.CLAIM_TOKEN_HEADER)
    }
}
