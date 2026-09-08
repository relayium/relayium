package com.relayium.android.inbox

import com.relayium.android.cloud.FakeSecretBox
import com.relayium.android.cloud.ScriptedDurableFiles
import com.relayium.protocol.inbox.InboxAutoAccept
import com.relayium.protocol.inbox.InboxCapability
import com.relayium.protocol.inbox.InboxKeyMaterial
import com.relayium.protocol.inbox.InboxProtocol
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Getting to "this device holds the private half of what senders wrap to".
 *
 * Nearly every case here is about a decision NOT taken: no second key minted
 * after a lost response, no rotation performed without a person, no key
 * published over a history that could not be read. Those are the failures that
 * are unrecoverable rather than retryable, so most assertions are about the
 * absence of a call.
 */
class InboxEnrolmentTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val secrets = FakeSecretBox()
    private val files = ScriptedDurableFiles()
    private val account = InboxAccountId("0000111122223333444455556666aaaa")
    private val transport = FakeInboxTransport()

    private fun store() = InboxKeyStore(folder.root, secrets, files)

    /**
     * Make the STORED history unreadable while leaving the store itself usable.
     *
     * Faithful to the real case in a way a global "every open fails" switch is
     * not: a keystore entry that was invalidated is replaced, so the old records
     * are dead while a freshly written history seals and opens normally. A
     * blanket failure would also break the repair's own new file, which is not
     * what recovery has to survive.
     */
    private fun corruptHistory() {
        val file = File(File(folder.root, InboxKeyStore.DIRECTORY), "${account.value}.json")
        val bytes = file.readBytes()
        bytes[bytes.size - 1] = (bytes[bytes.size - 1] + 1).toByte()
        file.writeBytes(bytes)
    }

    private fun remoteKey(
        id: String = "keyone",
        publicKey: String,
        generation: Long = 1,
        algorithm: String = InboxProtocol.KEY_ALGORITHM,
        supersededAt: Long = 0,
    ) = InboxKeyRow(id, algorithm, publicKey, generation, 1_700_000_000, supersededAt, 0)

    // ── enrolment negotiation fails closed ──────────────────────────────────

    private suspend fun enrolWith(result: InboxEnrolResult): InboxEnrolmentException? = try {
        transport.enrolResult = result
        InboxEnrolment.enrol(
            transport, "android", "0.1.0", InboxCapabilities.announced(true),
            InboxAutoAccept.OFF, receiveDirReady = true,
        )
        null
    } catch (e: InboxEnrolmentException) {
        e
    }

    private fun enrolResult(
        protocolVersion: Int = InboxProtocol.MAX_PROTOCOL_VERSION,
        receiveCapability: String = InboxCapability.REQUIRED_RECEIVE,
        keyAlgorithm: String = InboxProtocol.KEY_ALGORITHM,
    ) = InboxEnrolResult(
        inbox = InboxEnrolmentView.read(InboxFixtures.enrolment("Key" to null)),
        protocolVersion = protocolVersion,
        receiveCapability = receiveCapability,
        keyAlgorithm = keyAlgorithm,
    )

    @Test
    fun `each unsupported negotiated field is refused by name`() = runBlocking {
        assertEquals(
            InboxEnrolmentException.Field.PROTOCOL_VERSION,
            enrolWith(enrolResult(protocolVersion = 2))?.field,
        )
        // Checked against what was ANNOUNCED: central may only select from the
        // list this device sent, and `inbox.receive.v1` was never in it.
        assertEquals(
            InboxEnrolmentException.Field.RECEIVE_CAPABILITY,
            enrolWith(enrolResult(receiveCapability = InboxCapability.RECEIVE_V1))?.field,
        )
        assertEquals(
            InboxEnrolmentException.Field.KEY_ALGORITHM,
            enrolWith(enrolResult(keyAlgorithm = "pq-kem-v9"))?.field,
        )
    }

    /** The text token is a promise about a SCREEN, so it is announced only by a
     *  build whose surface actually renders a message as one. */
    @Test
    fun `the text capability is announced only when a surface presents text`() {
        assertTrue(InboxCapabilities.announced(true).contains(InboxCapability.TEXT_V1))
        assertFalse(InboxCapabilities.announced(false).contains(InboxCapability.TEXT_V1))
        assertTrue(InboxCapabilities.BASE.contains(InboxCapability.RESUME_V1))
    }

    // ── healthy, and what "healthy" has to prove ────────────────────────────

    @Test
    fun `a held key whose binding agrees is healthy`() = runBlocking {
        val store = store()
        val keyPair = InboxKeyMaterial.generateKeyPair()
        val publicKey = InboxKeyMaterial.encode(keyPair.publicKey)
        store.append(keyPair, account, 1_700_000_000)
        store.bind(publicKey, "keyone", 1, account)

        val health = InboxEnrolment.ensureUsableKey(
            transport, store, account, remoteKey(publicKey = publicKey), 1_700_000_100,
        )
        assertTrue(health is InboxKeyHealth.Healthy)
        assertEquals(0, transport.count("registerKey"))
    }

    /**
     * Matching the ID is not enough.
     *
     * A record filed under central's id whose PUBLIC key differs means the two
     * sides disagree about what that id names. Accepting it would have this
     * device advertise custody of a key it cannot use.
     */
    @Test
    fun `a binding that agrees on id but not on the key needs repair`() = runBlocking {
        val store = store()
        val mine = InboxKeyMaterial.generateKeyPair()
        store.append(mine, account, 1_700_000_000)
        store.bind(InboxKeyMaterial.encode(mine.publicKey), "keyone", 1, account)

        val elsewhere = InboxKeyMaterial.encode(InboxKeyMaterial.generateKeyPair().publicKey)
        val health = InboxEnrolment.ensureUsableKey(
            transport, store, account,
            remoteKey(id = "keyone", publicKey = elsewhere), 1_700_000_100,
        )
        assertEquals(
            InboxKeyHealth.NeedsRepair.Reason.LOCAL_BINDING_DISAGREES,
            (health as InboxKeyHealth.NeedsRepair).reason,
        )
        assertEquals(0, transport.count("registerKey"))
    }

    @Test
    fun `a binding that disagrees on generation needs repair`() = runBlocking {
        val store = store()
        val keyPair = InboxKeyMaterial.generateKeyPair()
        val publicKey = InboxKeyMaterial.encode(keyPair.publicKey)
        store.append(keyPair, account, 1_700_000_000)
        store.bind(publicKey, "keyone", 1, account)

        val health = InboxEnrolment.ensureUsableKey(
            transport, store, account,
            remoteKey(publicKey = publicKey, generation = 7), 1_700_000_100,
        )
        assertEquals(
            InboxKeyHealth.NeedsRepair.Reason.LOCAL_BINDING_DISAGREES,
            (health as InboxKeyHealth.NeedsRepair).reason,
        )
    }

    // ── the lost registration response ──────────────────────────────────────

    /**
     * The private half IS here; central simply told us its id in a reply that
     * never arrived. Repaired by recording the id — never by minting a second
     * key, which would abandon the first and strand anything sealed to it.
     */
    @Test
    fun `a lost registration response is repaired by binding, not by a new key`() = runBlocking {
        val store = store()
        val keyPair = InboxKeyMaterial.generateKeyPair()
        val publicKey = InboxKeyMaterial.encode(keyPair.publicKey)
        store.append(keyPair, account, 1_700_000_000)   // durable, never published

        val health = InboxEnrolment.ensureUsableKey(
            transport, store, account, remoteKey(publicKey = publicKey), 1_700_000_100,
        )
        assertTrue(health is InboxKeyHealth.Healthy)
        assertEquals("no key may be minted here", 1, store.load(account).size)
        assertEquals(0, transport.count("registerKey"))
        assertEquals("keyone", store.load(account).single().keyId)
    }

    // ── the repair that is not taken automatically ──────────────────────────

    /**
     * The central rule of this file. Central publishes a key this device cannot
     * open; rotating would silently abandon every task already queued to it, so
     * the decision is reported and left to a person.
     */
    @Test
    fun `an unheld remote key is reported and never rotated silently`() = runBlocking {
        val store = store()
        val elsewhere = InboxKeyMaterial.encode(InboxKeyMaterial.generateKeyPair().publicKey)

        val health = InboxEnrolment.ensureUsableKey(
            transport, store, account, remoteKey(publicKey = elsewhere), 1_700_000_100,
        )
        val repair = health as InboxKeyHealth.NeedsRepair
        assertEquals(InboxKeyHealth.NeedsRepair.Reason.REMOTE_KEY_NOT_HELD, repair.reason)
        assertEquals("keyone", repair.remoteKeyId)
        assertEquals(0, transport.count("registerKey"))
        assertTrue("nothing may be minted", store.load(account).isEmpty())
    }

    /** …and the repair, once a person asks for it, carries the compare-and-swap
     *  that stops two passes racing onto different keys. */
    @Test
    fun `the explicit repair rotates with a compare-and-swap`() = runBlocking {
        val store = store()
        val elsewhere = InboxKeyMaterial.encode(InboxKeyMaterial.generateKeyPair().publicKey)
        transport.keys.add(remoteKey(publicKey = elsewhere))

        val health = InboxEnrolment.repairByRotating(
            transport, store, account, "keyone", 1_700_000_200,
        )
        assertTrue(health is InboxKeyHealth.Healthy)
        assertEquals(listOf("keyone"), transport.previousKeyIds.toList())
        assertEquals(1, store.load(account).size)
        assertTrue(store.load(account).single().isPublished)
    }

    /** A lost CAS is re-read once, not looped: minting keys against a server
     *  that keeps disagreeing is how a history ends up with nothing usable. */
    @Test
    fun `a lost compare-and-swap is re-read rather than retried`() = runBlocking {
        val store = store()
        val elsewhere = InboxKeyMaterial.encode(InboxKeyMaterial.generateKeyPair().publicKey)
        transport.keys.add(remoteKey(id = "keytwo", publicKey = elsewhere))

        // Names a key that is no longer current, so the CAS loses.
        val health = InboxEnrolment.repairByRotating(
            transport, store, account, "keyone", 1_700_000_200,
        )
        assertEquals(
            InboxKeyHealth.NeedsRepair.Reason.REMOTE_KEY_NOT_HELD,
            (health as InboxKeyHealth.NeedsRepair).reason,
        )
        assertEquals("exactly one attempt", 1, transport.count("registerKey"))
    }

    // ── publishing ──────────────────────────────────────────────────────────

    @Test
    fun `a first key is minted, made durable, and then published`() = runBlocking {
        val store = store()
        val health = InboxEnrolment.ensureUsableKey(
            transport, store, account, null, 1_700_000_000,
        )
        assertTrue(health is InboxKeyHealth.Healthy)
        val record = store.load(account).single()
        assertTrue(record.isPublished)
        // The append must have happened before the registration; a write that
        // landed after it would mean central published a key whose private half
        // was not yet on disk.
        assertTrue(files.writes.isNotEmpty())
    }

    @Test
    fun `an unpublished local key is published rather than replaced`() = runBlocking {
        val store = store()
        val keyPair = InboxKeyMaterial.generateKeyPair()
        store.append(keyPair, account, 1_700_000_000)

        InboxEnrolment.ensureUsableKey(transport, store, account, null, 1_700_000_100)
        assertEquals("no second key", 1, store.load(account).size)
        assertEquals(
            InboxKeyMaterial.encode(keyPair.publicKey),
            store.load(account).single().publicKey,
        )
    }

    /**
     * A published record is NOT a publish candidate.
     *
     * Central having no active key while this device holds a published one is a
     * genuinely new remote identity — a cleared enrolment, a re-login that minted
     * a new device row. Re-registering the old key would be refused as reuse at
     * best; the honest answer is a new key, with the old record left exactly
     * where it is so anything still sealed to it stays openable.
     */
    @Test
    fun `a published local key is not republished when central has none`() = runBlocking {
        val store = store()
        val keyPair = InboxKeyMaterial.generateKeyPair()
        val publicKey = InboxKeyMaterial.encode(keyPair.publicKey)
        store.append(keyPair, account, 1_700_000_000)
        store.bind(publicKey, "keyold", 1, account)

        val health = InboxEnrolment.ensureUsableKey(
            transport, store, account, null, 1_700_000_100,
        )
        assertTrue(health is InboxKeyHealth.Healthy)
        val history = store.load(account)
        assertEquals("a new key, and the old one kept", 2, history.size)
        assertEquals(publicKey, history.first().publicKey)
        assertEquals("keyold", history.first().keyId)
        assertNotNull("the old private half must still resolve", store.keyPair("keyold", account))
    }

    /**
     * An ambiguous registration failure must not mint a second key: the record is
     * already durable, so the next pass reuses it and central tells us for
     * certain what happened.
     */
    @Test
    fun `an ambiguous registration failure leaves exactly one key to retry`() = runBlocking {
        val store = store()
        transport.registerFailure =
            InboxTransportException(InboxTransportException.Kind.TIMEOUT)

        val failed = try {
            InboxEnrolment.ensureUsableKey(transport, store, account, null, 1_700_000_000)
            false
        } catch (_: InboxTransportException) {
            true
        }
        assertTrue(failed)
        val afterFailure = store.load(account)
        assertEquals("the key is durable and unpublished", 1, afterFailure.size)
        assertFalse(afterFailure.single().isPublished)

        // The retry publishes the SAME key.
        InboxEnrolment.ensureUsableKey(transport, store, account, null, 1_700_000_100)
        val afterRetry = store.load(account)
        assertEquals(1, afterRetry.size)
        assertEquals(afterFailure.single().publicKey, afterRetry.single().publicKey)
        assertTrue(afterRetry.single().isPublished)
    }

    // ── ambiguity on central's side ─────────────────────────────────────────

    /** Two active rows: no first-row rule. Choosing one would mean this build
     *  deciding which deliveries it can open. */
    @Test
    fun `more than one active remote key is ambiguous, not resolved to the first`() = runBlocking {
        val store = store()
        val keyPair = InboxKeyMaterial.generateKeyPair()
        store.append(keyPair, account, 1_700_000_000)
        val a = InboxKeyMaterial.encode(InboxKeyMaterial.generateKeyPair().publicKey)
        val b = InboxKeyMaterial.encode(InboxKeyMaterial.generateKeyPair().publicKey)
        transport.keys.add(remoteKey(id = "keyone", publicKey = a))
        transport.keys.add(remoteKey(id = "keytwo", publicKey = b, generation = 2))
        // Force the reconcile path: central refuses the publish as reuse.
        transport.registerFailure =
            InboxApiException(409, com.relayium.protocol.inbox.InboxRejection.DEVICE_KEY_REUSED)

        val health = InboxEnrolment.ensureUsableKey(
            transport, store, account, null, 1_700_000_100,
        )
        assertEquals(
            InboxKeyHealth.NeedsRepair.Reason.REMOTE_KEY_AMBIGUOUS,
            (health as InboxKeyHealth.NeedsRepair).reason,
        )
    }

    // ── the unreadable history, and its recovery ────────────────────────────

    /** An unreadable history is its own repair reason, and no key is published
     *  over it: the private halves may still be there behind a keystore entry
     *  that was invalidated. */
    @Test
    fun `an unreadable history is reported and nothing is published over it`() = runBlocking {
        val store = store()
        store.append(InboxKeyMaterial.generateKeyPair(), account, 1_700_000_000)
        corruptHistory()

        val health = InboxEnrolment.ensureUsableKey(
            transport, store, account, null, 1_700_000_100,
        )
        assertEquals(
            InboxKeyHealth.NeedsRepair.Reason.LOCAL_HISTORY_UNREADABLE,
            (health as InboxKeyHealth.NeedsRepair).reason,
        )
        assertEquals(0, transport.count("registerKey"))
    }

    /**
     * The recovery that would otherwise loop forever.
     *
     * `append` reads before it writes, so an unreadable file fails every attempt
     * — the device would sit in `LOCAL_HISTORY_UNREADABLE` with no way out. The
     * confirmed repair moves the old bytes aside, PRESERVING them, and starts a
     * usable history.
     */
    @Test
    fun `the confirmed repair recovers from an unreadable history without deleting it`() =
        runBlocking {
            val store = store()
            store.append(InboxKeyMaterial.generateKeyPair(), account, 1_700_000_000)
            corruptHistory()

            // The regression this repair exists for: an ordinary publish cannot
            // get past the unreadable file.
            val looping = try {
                store.append(InboxKeyMaterial.generateKeyPair(), account, 1_700_000_100)
                false
            } catch (e: InboxKeyStoreException) {
                e.reason == InboxKeyStoreReason.UNREADABLE_HISTORY
            }
            assertTrue("append must fail while the history is unreadable", looping)

            val health = InboxEnrolment.repairUnreadableHistory(
                transport, store, account, 1_700_000_200,
            )
            assertTrue(health is InboxKeyHealth.Healthy)

            val directory = File(folder.root, InboxKeyStore.DIRECTORY)
            val quarantined = directory.listFiles()
                .orEmpty().filter { it.name.contains(".unreadable.") }
            assertEquals("the old bytes are kept, not deleted", 1, quarantined.size)
            assertTrue(quarantined.single().length() > 0)

            val fresh = store.load(account)
            assertEquals(1, fresh.size)
            assertTrue(fresh.single().isPublished)
        }

    /**
     * An INVALIDATED keystore, not merely a corrupt file.
     *
     * The old records cannot be opened and a replacement cannot be sealed
     * either. Renaming the history would satisfy the mechanics of the repair
     * while leaving the device exactly as unable to receive — and would have
     * destroyed the only copy of the private halves that a restored keystore
     * could still have opened. So the honest answer is that the repair is not
     * available here, and the old history stays where it is.
     */
    @Test
    fun `an invalidated keystore reports an unavailable repair and destroys nothing`() =
        runBlocking {
            val store = store()
            store.append(InboxKeyMaterial.generateKeyPair(), account, 1_700_000_000)
            val directory = File(folder.root, InboxKeyStore.DIRECTORY)
            val before = File(directory, "${account.value}.json").readBytes()

            // Both directions gone: this is what an invalidated key looks like,
            // and it is what a corrupt-file fixture cannot express.
            secrets.openFails = true
            secrets.sealFails = true

            val health = InboxEnrolment.repairUnreadableHistory(
                transport, store, account, 1_700_000_200,
            )
            assertEquals(
                InboxKeyHealth.RepairUnavailable.Reason.SECURE_STORAGE_UNAVAILABLE,
                (health as InboxKeyHealth.RepairUnavailable).reason,
            )
            assertEquals("no key may be published", 0, transport.count("registerKey"))
            assertTrue(
                "the history must still be under its live name",
                File(directory, "${account.value}.json").exists(),
            )
            assertArrayEquals(before, File(directory, "${account.value}.json").readBytes())
            assertTrue(
                "nothing may have been quarantined",
                directory.listFiles().orEmpty().none { it.name.contains(".unreadable.") },
            )
        }

    /**
     * An ambiguous remote history stops the explicit repair BEFORE it destroys
     * anything.
     *
     * "No active key" and "two active keys" must not share one answer: the first
     * licenses publishing a new key, the second means central and this device
     * cannot agree on what identity is current. Treating the second as the first
     * would quarantine the local history and register a key while central holds
     * two — with the old records already moved aside.
     */
    @Test
    fun `an ambiguous remote history stops the repair before anything is destroyed`() =
        runBlocking {
            val store = store()
            store.append(InboxKeyMaterial.generateKeyPair(), account, 1_700_000_000)
            corruptHistory()
            val a = InboxKeyMaterial.encode(InboxKeyMaterial.generateKeyPair().publicKey)
            val b = InboxKeyMaterial.encode(InboxKeyMaterial.generateKeyPair().publicKey)
            transport.keys.add(remoteKey(id = "keyone", publicKey = a))
            transport.keys.add(remoteKey(id = "keytwo", publicKey = b, generation = 2))

            val health = InboxEnrolment.repairUnreadableHistory(
                transport, store, account, 1_700_000_200,
            )
            assertEquals(
                InboxKeyHealth.NeedsRepair.Reason.REMOTE_KEY_AMBIGUOUS,
                (health as InboxKeyHealth.NeedsRepair).reason,
            )
            assertEquals("nothing may be registered", 0, transport.count("registerKey"))
            val directory = File(folder.root, InboxKeyStore.DIRECTORY)
            assertTrue(
                "the history must still be under its live name",
                File(directory, "${account.value}.json").exists(),
            )
            assertTrue(
                "nothing may have been quarantined",
                directory.listFiles().orEmpty().none { it.name.contains(".unreadable.") },
            )
        }

    /** Quarantine is a repair for an unreadable file, and refuses to move a
     *  readable one — that would abandon live keys for no reason. */
    @Test
    fun `quarantine refuses a readable history`() = runBlocking {
        val store = store()
        store.append(InboxKeyMaterial.generateKeyPair(), account, 1_700_000_000)
        val e = try {
            store.quarantineUnreadable(account)
            null
        } catch (thrown: InboxKeyStoreException) {
            thrown
        }
        assertEquals(InboxKeyStoreReason.STORAGE, e?.reason)
        assertEquals(1, store.load(account).size)
    }
}
