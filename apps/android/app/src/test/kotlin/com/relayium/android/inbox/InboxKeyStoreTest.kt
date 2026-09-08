package com.relayium.android.inbox

import com.relayium.android.cloud.FakeSecretBox
import com.relayium.android.cloud.ScriptedDurableFiles
import com.relayium.protocol.inbox.InboxKeyMaterial
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The private-key history.
 *
 * The properties here are the ones whose failure is UNRECOVERABLE rather than
 * retryable: a key that was published before it was durable, a superseded key
 * dropped while tasks are still sealed to it, an unreadable history mistaken for
 * an empty one. Each of those turns into ciphertext nobody can ever open.
 */
class InboxKeyStoreTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val secrets = FakeSecretBox()
    private val files = ScriptedDurableFiles()
    private val account = InboxAccountId("0000111122223333444455556666aaaa")
    private val other = InboxAccountId("9999888877776666555544443333bbbb")

    private fun store(root: File = folder.root) = InboxKeyStore(root, secrets, files)

    private fun newKeyPair() = InboxKeyMaterial.generateKeyPair()

    // ── the ordering that makes publish safe ────────────────────────────────

    /**
     * `append` returns only once the record is on disk. Everything about the
     * publish ordering rests on this: if registration then fails, the worst case
     * is an unpublished local key, which is recoverable — where the reverse order
     * leaves central handing senders a public key whose private half never
     * existed.
     */
    @Test
    fun `append makes the private key durable before it can be published`() = runBlocking {
        val keyPair = newKeyPair()
        val record = store().append(keyPair, account, 1_700_000_000)
        assertFalse("a fresh record is unpublished", record.isPublished)
        assertEquals("", record.keyId)
        assertTrue("a durable write must have happened", files.writes.isNotEmpty())
        // A different store instance over the same directory: the record is real
        // storage, not this object's memory.
        val reloaded = store().load(account)
        assertEquals(1, reloaded.size)
        assertEquals(record.publicKey, reloaded.single().publicKey)
    }

    @Test
    fun `a write failure is reported and nothing is recorded`() = runBlocking {
        files.failWrites.add("${account.value}.json")
        val e = try {
            store().append(newKeyPair(), account, 1_700_000_000)
            null
        } catch (thrown: InboxKeyStoreException) {
            thrown
        }
        assertEquals(InboxKeyStoreReason.STORAGE, e?.reason)
        files.failWrites.clear()
        assertTrue(store().load(account).isEmpty())
    }

    // ── history, not a key ──────────────────────────────────────────────────

    /**
     * The reason this is a history at all. Central binds a task to the key it
     * was sealed to at creation, so a rotation must not drop the old private
     * half — every task queued before it is still sealed to exactly that key.
     */
    @Test
    fun `a superseded key stays resolvable after a rotation`() = runBlocking {
        val store = store()
        val first = newKeyPair()
        val second = newKeyPair()
        store.append(first, account, 1_700_000_000)
        store.bind(InboxKeyMaterial.encode(first.publicKey), "keyone", 1, account)
        store.append(second, account, 1_700_000_500)
        store.bind(InboxKeyMaterial.encode(second.publicKey), "keytwo", 2, account)

        val old = requireNotNull(store.keyPair("keyone", account)) {
            "a task queued to the superseded key can no longer be opened"
        }
        assertArrayEquals(first.publicKey, old.publicKey)
        val current = requireNotNull(store.keyPair("keytwo", account))
        assertArrayEquals(second.publicKey, current.publicKey)
        assertEquals(2, store.load(account).size)
    }

    @Test
    fun `an unknown key id resolves to nothing rather than to the newest key`() = runBlocking {
        val store = store()
        val keyPair = newKeyPair()
        store.append(keyPair, account, 1_700_000_000)
        store.bind(InboxKeyMaterial.encode(keyPair.publicKey), "keyone", 1, account)
        assertNull(store.keyPair("keytwo", account))
        // An unpublished record has no id, and the empty string must not match it.
        assertNull(store.keyPair("", account))
    }

    @Test
    fun `re-appending an existing public key is refused`() = runBlocking {
        val store = store()
        val keyPair = newKeyPair()
        store.append(keyPair, account, 1_700_000_000)
        val e = try {
            store.append(keyPair, account, 1_700_000_100)
            null
        } catch (thrown: InboxKeyStoreException) {
            thrown
        }
        assertEquals(InboxKeyStoreReason.KEY_ALREADY_PRESENT, e?.reason)
    }

    // ── binding ─────────────────────────────────────────────────────────────

    @Test
    fun `bind records the id central chose and is idempotent`() = runBlocking {
        val store = store()
        val keyPair = newKeyPair()
        val publicKey = InboxKeyMaterial.encode(keyPair.publicKey)
        store.append(keyPair, account, 1_700_000_000)
        store.bind(publicKey, "keyone", 3, account)
        store.bind(publicKey, "keyone", 3, account)
        val record = requireNotNull(store.record(publicKey, account))
        assertEquals("keyone", record.keyId)
        assertEquals(3L, record.generation)
        assertTrue(record.isPublished)
    }

    /** One server id, one local key. Two would make "which private key opens
     *  this task" ambiguous, and the wrong answer is an unopenable delivery. */
    @Test
    fun `binding one server id to a second local key is refused`() = runBlocking {
        val store = store()
        val first = newKeyPair()
        val second = newKeyPair()
        store.append(first, account, 1_700_000_000)
        store.append(second, account, 1_700_000_100)
        store.bind(InboxKeyMaterial.encode(first.publicKey), "keyone", 1, account)
        val e = try {
            store.bind(InboxKeyMaterial.encode(second.publicKey), "keyone", 2, account)
            null
        } catch (thrown: InboxKeyStoreException) {
            thrown
        }
        assertEquals(InboxKeyStoreReason.KEY_ID_ALREADY_BOUND, e?.reason)
    }

    @Test
    fun `binding a key this account does not hold is refused`() = runBlocking {
        val e = try {
            store().bind(InboxFixtures.publicKey, "keyone", 1, account)
            null
        } catch (thrown: InboxKeyStoreException) {
            thrown
        }
        assertEquals(InboxKeyStoreReason.NO_SUCH_LOCAL_KEY, e?.reason)
    }

    // ── absent versus unreadable ────────────────────────────────────────────

    /** First run. Not a failure, and the only case that may read as "no keys". */
    @Test
    fun `an absent history is an empty one`() = runBlocking {
        assertTrue(store().load(account).isEmpty())
        assertNull(store().latest(account))
    }

    /**
     * The distinction that matters most in this file.
     *
     * An unreadable history must NOT present as "this device has never had a
     * key" — that answer invites a rotation, and a rotation abandons every task
     * already queued to a key that may still be sitting in the file we simply
     * could not open.
     */
    @Test
    fun `an unreadable history is refused rather than read as empty`() = runBlocking {
        val store = store()
        store.append(newKeyPair(), account, 1_700_000_000)
        secrets.openFails = true
        val e = try {
            store.load(account)
            null
        } catch (thrown: InboxKeyStoreException) {
            thrown
        }
        assertEquals(InboxKeyStoreReason.UNREADABLE_HISTORY, e?.reason)
        secrets.openFails = false
        assertEquals(1, store.load(account).size)
    }

    @Test
    fun `a history whose bytes were altered is refused`() = runBlocking {
        store().append(newKeyPair(), account, 1_700_000_000)
        val file = File(File(folder.root, InboxKeyStore.DIRECTORY), "${account.value}.json")
        file.writeBytes(file.readBytes().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() })
        val e = try {
            store().load(account)
            null
        } catch (thrown: InboxKeyStoreException) {
            thrown
        }
        assertEquals(InboxKeyStoreReason.UNREADABLE_HISTORY, e?.reason)
    }

    // ── what a persisted history may not say ────────────────────────────────

    /**
     * Write a history the store would never have produced, and see it refused.
     *
     * Sealed under the real label so the record is authentic — the point is not
     * that tampering is detected (the case above covers that) but that a
     * well-sealed document whose CONTENT is impossible is still refused. A
     * lenient reader would accept every one of these and then be wrong about
     * which private key opens which delivery.
     */
    private fun writeRawHistory(json: String) {
        val directory = File(folder.root, InboxKeyStore.DIRECTORY)
        directory.mkdirs()
        File(directory, "${account.value}.json").writeBytes(
            secrets.seal(
                "${InboxKeyStore.LABEL_PREFIX}/${account.value}",
                json.toByteArray(Charsets.UTF_8),
            ),
        )
    }

    private fun record(
        keyId: String = "keyone",
        generation: Long = 1,
        algorithm: String = com.relayium.protocol.inbox.InboxProtocol.KEY_ALGORITHM,
        publicKey: String,
        privateKey: String,
    ) = """{"keyId":"$keyId","generation":$generation,"algorithm":"$algorithm",""" +
        """"publicKey":"$publicKey","privateKey":"$privateKey","createdAt":1700000000}"""

    private fun history(vararg records: String, version: String = "1") =
        """{"version":$version,"keys":[${records.joinToString(",")}]}"""

    private fun assertUnreadable(json: String, why: String) = runBlocking {
        writeRawHistory(json)
        val e = try {
            store().load(account)
            null
        } catch (thrown: InboxKeyStoreException) {
            thrown
        }
        assertEquals(why, InboxKeyStoreReason.UNREADABLE_HISTORY, e?.reason)
    }

    @Test
    fun `a persisted history that could not have been written is refused`() {
        val pair = newKeyPair()
        val publicKey = InboxKeyMaterial.encode(pair.publicKey)
        val privateKey = InboxKeyMaterial.encode(pair.privateKeyCopy())
        val second = newKeyPair()
        val otherPublic = InboxKeyMaterial.encode(second.publicKey)
        val otherPrivate = InboxKeyMaterial.encode(second.privateKeyCopy())
        val good = record(publicKey = publicKey, privateKey = privateKey)

        // A version read through `toInt()` would call this a 1.
        assertUnreadable(history(good, version = "1.9"), "a fractional version is not version 1")
        assertUnreadable(history(good, version = "2"), "a future version")
        assertUnreadable(
            history(record(algorithm = "pq-kem-v9", publicKey = publicKey, privateKey = privateKey)),
            "an algorithm this build cannot use",
        )
        // The two halves of "central acknowledged this" must agree.
        assertUnreadable(
            history(record(generation = 0, publicKey = publicKey, privateKey = privateKey)),
            "published with no generation",
        )
        assertUnreadable(
            history(record(keyId = "", generation = 3, publicKey = publicKey, privateKey = privateKey)),
            "unpublished but carrying a generation",
        )
        assertUnreadable(
            history(record(keyId = "../escape", publicKey = publicKey, privateKey = privateKey)),
            "a key id that is not one central mints",
        )
        // "Which private key opens this task" must have exactly one answer.
        assertUnreadable(
            history(
                good,
                record(publicKey = otherPublic, privateKey = otherPrivate),
            ),
            "two records under one key id",
        )
        assertUnreadable(
            history(
                good,
                record(keyId = "keytwo", generation = 2, publicKey = publicKey, privateKey = privateKey),
            ),
            "one public key filed twice",
        )
        // The sharp one: a record that looks complete but whose halves do not
        // belong together. It fails only when a real delivery cannot be opened.
        assertUnreadable(
            history(record(publicKey = publicKey, privateKey = otherPrivate)),
            "a private half that does not match its public half",
        )
        assertUnreadable(
            history(record(publicKey = publicKey, privateKey = "not-base64url!!")),
            "key material that is not canonical base64url",
        )
        assertUnreadable(
            """{"version":1,"keys":[{"keyId":"keyone"}]}""",
            "a record missing its fields",
        )
        assertUnreadable("""{"version":1}""", "no keys array at all")
    }

    /** The exact history the store itself writes must of course be readable —
     *  otherwise every case above would pass for the wrong reason. */
    @Test
    fun `a history this store wrote reads back`() = runBlocking {
        val store = store()
        val pair = newKeyPair()
        store.append(pair, account, 1_700_000_000)
        store.bind(InboxKeyMaterial.encode(pair.publicKey), "keyone", 1, account)
        val record = store.load(account).single()
        assertEquals("keyone", record.keyId)
        assertEquals(1L, record.generation)
        assertNotNull(store.keyPair("keyone", account))
    }

    // ── rebinding a published record ────────────────────────────────────────

    /**
     * Once central has acknowledged a key, its id is what every task already
     * queued to that key names in `TargetKeyID`. Overwriting the binding would
     * make those deliveries unresolvable while the private half sits right
     * there, so a non-identical rebinding is refused and the old id keeps
     * working.
     */
    @Test
    fun `rebinding a published record is refused and the old binding still resolves`() =
        runBlocking {
            val store = store()
            val pair = newKeyPair()
            val publicKey = InboxKeyMaterial.encode(pair.publicKey)
            store.append(pair, account, 1_700_000_000)
            store.bind(publicKey, "keyone", 1, account)

            val attempts: List<Pair<String, Long>> = listOf("keytwo" to 1L, "keyone" to 2L)
            for (attempt in attempts) {
                val e = try {
                    store.bind(publicKey, attempt.first, attempt.second, account)
                    null
                } catch (thrown: InboxKeyStoreException) {
                    thrown
                }
                assertEquals(
                    "rebinding to ${attempt.first}/${attempt.second}",
                    InboxKeyStoreReason.KEY_ALREADY_PUBLISHED, e?.reason,
                )
            }
            val record = store.load(account).single()
            assertEquals("keyone", record.keyId)
            assertEquals(1L, record.generation)
            assertNotNull(
                "a task queued to keyone must still resolve",
                store.keyPair("keyone", account),
            )
            assertNull(store.keyPair("keytwo", account))
        }

    // ── account isolation ───────────────────────────────────────────────────

    /**
     * Two accounts on one device, in sequence. An operation started under one
     * must not read the other's keys, and destroying one must not reach the
     * other's history.
     */
    @Test
    fun `accounts are isolated and destroy is scoped to one`() = runBlocking {
        val store = store()
        val mine = newKeyPair()
        val theirs = newKeyPair()
        store.append(mine, account, 1_700_000_000)
        store.append(theirs, other, 1_700_000_000)
        store.bind(InboxKeyMaterial.encode(mine.publicKey), "keyone", 1, account)
        store.bind(InboxKeyMaterial.encode(theirs.publicKey), "keytwo", 1, other)

        assertNull("one account must not resolve the other's key", store.keyPair("keytwo", account))
        store.destroy(account)
        assertTrue(store.load(account).isEmpty())
        assertEquals(1, store.load(other).size)
        assertNotEquals(null, store.keyPair("keytwo", other))
    }

    /**
     * The label binds the account, so a record file moved between accounts fails
     * to open rather than decrypting into the wrong history.
     */
    @Test
    fun `a history file moved to another account does not open`() = runBlocking {
        val store = store()
        store.append(newKeyPair(), account, 1_700_000_000)
        val directory = File(folder.root, InboxKeyStore.DIRECTORY)
        File(directory, "${account.value}.json")
            .copyTo(File(directory, "${other.value}.json"), overwrite = true)
        val e = try {
            store.load(other)
            null
        } catch (thrown: InboxKeyStoreException) {
            thrown
        }
        assertEquals(InboxKeyStoreReason.UNREADABLE_HISTORY, e?.reason)
    }

    /**
     * A transient storage failure is not evidence that a history is worthless.
     *
     * Quarantine's whole job is destructive, so what it accepts as proof matters
     * more than what it does: a broad catch would let an I/O blip — or a
     * cancelled repair — stand in for "unreadable" and move a perfectly good key
     * history out from under the deliveries queued to it.
     */
    @Test
    fun `quarantine refuses to act on a failure that is not unreadability`() = runBlocking {
        val store = store()
        store.append(newKeyPair(), account, 1_700_000_000)
        val file = File(File(folder.root, InboxKeyStore.DIRECTORY), "${account.value}.json")
        val before = file.readBytes()

        val e = try {
            store.quarantineUnreadable(account)
            null
        } catch (thrown: InboxKeyStoreException) {
            thrown
        }
        assertEquals(InboxKeyStoreReason.STORAGE, e?.reason)
        assertTrue(file.exists())
        assertArrayEquals(before, file.readBytes())
    }

    /** One account's repair must not reach another's records. */
    @Test
    fun `quarantine is scoped to one account`() = runBlocking {
        val store = store()
        store.append(newKeyPair(), account, 1_700_000_000)
        store.append(newKeyPair(), other, 1_700_000_000)
        val directory = File(folder.root, InboxKeyStore.DIRECTORY)
        val theirs = File(directory, "${other.value}.json")
        val before = theirs.readBytes()

        val mine = File(directory, "${account.value}.json")
        mine.writeBytes(mine.readBytes().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() })
        assertTrue(store.quarantineUnreadable(account))

        assertTrue("the other account is untouched", theirs.exists())
        assertArrayEquals(before, theirs.readBytes())
        assertEquals(1, store.load(other).size)
    }

    /** The probe is a ROUND TRIP: what a repair needs is that a record written
     *  now can be read back later, not merely that a seal returned bytes. */
    @Test
    fun `the storage probe answers false when the keystore cannot round-trip`() = runBlocking {
        val store = store()
        assertTrue(store.canStoreNewHistory(account))
        secrets.sealFails = true
        assertFalse(store.canStoreNewHistory(account))
        secrets.sealFails = false
        secrets.openFails = true
        assertFalse(store.canStoreNewHistory(account))
    }

    /**
     * A removal that could not be made durable must SAY so.
     *
     * Reporting success on a refused sync would let a surface tell the user
     * their keys are gone while the file is still recoverable — and key removal
     * is exactly the claim a person acts on.
     */
    @Test
    fun `destroy reports a refused directory sync rather than claiming success`() = runBlocking {
        val barriers = SyncFailingDurableFiles(files)
        val store = InboxKeyStore(folder.root, secrets, barriers)
        store.append(newKeyPair(), account, 1_700_000_000)
        barriers.failSyncs.add(File(folder.root, InboxKeyStore.DIRECTORY).absolutePath)

        val e = try {
            store.destroy(account)
            null
        } catch (thrown: InboxKeyStoreException) {
            thrown
        }
        assertEquals(InboxKeyStoreReason.STORAGE, e?.reason)
    }

    /** The alias is this feature's own: sharing the cloud upload key would mean
     *  an invalidation aimed at either silently took both. */
    @Test
    fun `the keystore alias and label are not the cloud upload ones`() {
        assertNotEquals(
            com.relayium.android.cloud.KeystoreSecretBox.DEFAULT_ALIAS,
            InboxKeyStore.ALIAS,
        )
        assertTrue(InboxKeyStore.LABEL_PREFIX.startsWith("relayium/inbox/"))
    }
}
