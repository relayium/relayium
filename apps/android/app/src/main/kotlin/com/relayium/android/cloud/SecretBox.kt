package com.relayium.android.cloud

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Wrapping for the private bytes a pending upload leaves on this device.
 *
 * Two things go through it and neither may be readable from a copy of the app's
 * data directory: an upload's CONTENT KEY, which is the whole file, and its
 * PLAN, which carries the user's filenames and sizes. The spooled ciphertext
 * beside them needs no wrapping — it is already sealed under the content key,
 * and re-encrypting a gigabyte to hide bytes the server is about to hold anyway
 * would buy nothing.
 *
 * ## [label] is authenticated, and that is what stops a record being moved
 *
 * Every record is sealed with a label naming WHAT it is and WHICH job or account
 * owns it, passed to AES-GCM as additional authenticated data. Without it, a
 * wrapped record is a portable blob: copying one job's `key.bin` over another's
 * would hand the second job the first one's content key, and copying an account's
 * stored-link key under a different account's directory would let it reconstruct
 * a link it never made. Both are file moves inside the app's own data directory,
 * which is exactly the reach a restored backup or a debuggable build's `run-as`
 * has. The label makes them decrypt failures rather than silent adoptions.
 *
 * **Every failure throws.** A box that answered "nothing here" for a record it
 * could not unwrap would turn a keystore problem into a silently discarded
 * upload, and the two need different answers from the user.
 */
interface SecretBox {

    /** Seal [plaintext] under [label]. Throws [SecretBoxException] if it cannot. */
    fun seal(label: String, plaintext: ByteArray): ByteArray

    /**
     * Unseal what `seal(label, …)` produced under the SAME label.
     *
     * Throws [SecretBoxException] for anything else — bytes that were altered, a
     * key that is gone, and a record sealed under a different label.
     */
    fun open(label: String, sealed: ByteArray): ByteArray
}

/** A wrap or unwrap that did not happen. The message names the operation and
 *  never the value: these plaintexts are a content key and a list of the user's
 *  filenames. */
class SecretBoxException(message: String, cause: Throwable? = null) :
    Exception(message, cause)

/**
 * `AndroidKeyStore` AES-256-GCM, under this feature's OWN alias.
 *
 * ## Why not the bearer's key
 *
 * [com.relayium.android.account.KeystoreTokenStore] deletes its alias on
 * `clear()`, which is what makes a sign-out unrecoverable. Sharing that alias
 * would mean signing out destroyed the content key of every interrupted upload
 * on the device — including one belonging to the account the user is about to
 * sign back into. Signing out HIDES a pending job (see [PendingUploadStore] and
 * the account fences in [CloudUploadModel]); it does not shred the bytes.
 *
 * The alias is created on first use and never deleted by this app. Discarding a
 * job removes the job's own files, which is what makes its key unrecoverable —
 * the alias alone opens nothing.
 *
 * ## Creating the alias is serialised
 *
 * `KeyGenerator.generateKey` REPLACES an existing entry under the same alias, so
 * two callers racing through "look it up, and generate one if it is missing"
 * can leave the second one's key installed over the first one's — after the
 * first has already sealed records with the key that no longer exists. Those
 * records are then permanently unreadable. The pending-upload store and the
 * stored-link key store are two such callers and they run concurrently, so the
 * lookup-and-create is taken under a process-wide lock per alias, with the
 * lookup repeated inside it. The app declares no `android:process`, so one
 * process is the whole population of callers.
 *
 * As in the token store, this is deliberately NOT described as hardware-backed:
 * whether the key lives in a TEE or in a software keymaster is a property of the
 * device, and nothing here queries `KeyInfo`. The honest claim is that the key
 * material is held by the platform key store rather than by this app.
 * (https://developer.android.com/privacy-and-security/keystore)
 */
class KeystoreSecretBox(private val alias: String = DEFAULT_ALIAS) : SecretBox {

    override fun seal(label: String, plaintext: ByteArray): ByteArray {
        val key = try {
            usableKey()
        } catch (e: GeneralSecurityException) {
            throw SecretBoxException("no usable keystore key for pending uploads", e)
        }
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            cipher.updateAAD(aad(label))
            // The keystore's own IV. `setRandomizedEncryptionRequired` refuses a
            // caller-supplied one, which is the correct refusal: one repeated
            // nonce under this key would compromise every record under it.
            val iv = cipher.iv
            val body = cipher.doFinal(plaintext)
            require(iv.size in 1..255) { "unexpected IV length" }
            ByteArray(2 + iv.size + body.size).also { out ->
                out[0] = FORMAT_VERSION
                out[1] = iv.size.toByte()
                System.arraycopy(iv, 0, out, 2, iv.size)
                System.arraycopy(body, 0, out, 2 + iv.size, body.size)
            }
        } catch (e: GeneralSecurityException) {
            throw SecretBoxException("the record could not be wrapped", e)
        }
    }

    override fun open(label: String, sealed: ByteArray): ByteArray {
        if (sealed.size < 3 || sealed[0] != FORMAT_VERSION) {
            throw SecretBoxException("the record is not in a format this build can read")
        }
        val ivLength = sealed[1].toInt() and 0xFF
        if (ivLength == 0 || sealed.size <= 2 + ivLength) {
            throw SecretBoxException("the record is truncated")
        }
        val key = try {
            existingKey()
        } catch (e: GeneralSecurityException) {
            throw SecretBoxException("the keystore key for this record is unavailable", e)
        } ?: throw SecretBoxException("the keystore key for this record no longer exists")
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, sealed, 2, ivLength))
            cipher.updateAAD(aad(label))
            cipher.doFinal(sealed, 2 + ivLength, sealed.size - 2 - ivLength)
        } catch (e: GeneralSecurityException) {
            // Includes AEADBadTagException, which covers all three of "the file
            // was altered", "the key was invalidated" and "this record belongs
            // to another job". Each means this record is not usable here, and
            // none of them is "there was never one".
            throw SecretBoxException("the record could not be unwrapped", e)
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    private fun existingKey(): SecretKey? = keyStore().getKey(alias, null) as? SecretKey

    /** The alias's key, created once. See the class note on why this is locked. */
    private fun usableKey(): SecretKey {
        existingKey()?.let { return it }
        synchronized(lockFor(alias)) {
            existingKey()?.let { return it }
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
            generator.init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    // No user-authentication requirement, for the reason the
                    // token store gives: this app has no lock of its own, and
                    // requiring one would make an interrupted upload unresumable
                    // on a device with no secure lock screen.
                    .setUserAuthenticationRequired(false)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            return generator.generateKey()
        }
    }

    companion object {
        /** Distinct from the bearer's alias on purpose — see the class note. */
        const val DEFAULT_ALIAS = "com.relayium.android.cloud.pending.v1"

        private const val PROVIDER = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
        private const val FORMAT_VERSION: Byte = 1

        private val locks = HashMap<String, Any>()

        private fun lockFor(alias: String): Any = synchronized(locks) {
            locks.getOrPut(alias) { Any() }
        }
    }
}

/** The authenticated label bytes. UTF-8 and nothing else, so the same string
 *  always produces the same AAD on every device and build. */
internal fun aad(label: String): ByteArray = label.toByteArray(Charsets.UTF_8)

/**
 * Replace a file's contents so a crash leaves the OLD contents or the NEW ones
 * and never a blend: temporary sibling, `fd.sync()`, rename, then [syncDirectory]
 * — the rename is a directory write, and the file sync says nothing about it.
 */
internal fun writeFileAtomically(file: File, bytes: ByteArray) {
    val directory = file.parentFile ?: throw IOException("no parent directory")
    createDirectoryDurably(directory)
    val temporary = File(directory, "${file.name}.tmp")
    try {
        FileOutputStream(temporary).use { out ->
            out.write(bytes)
            out.flush()
            out.fd.sync()
        }
        if (!temporary.renameTo(file)) throw IOException("the file could not be moved into place")
        syncDirectory(directory)
    } finally {
        if (temporary.exists()) temporary.delete()
    }
}

/**
 * The durable-write operations this feature's crash ordering depends on.
 *
 * An interface, and the ONLY reason is testability of the barriers themselves:
 * the recovery rules turn on "this write landed before that request left", and a
 * JVM test cannot make a real `fsync` fail on demand. [Platform] is the
 * mandatory default and is what every production construction uses; a substitute
 * exists to fail a chosen barrier deliberately, never to skip one.
 *
 * Nothing here inspects the runtime, the build variant or the test framework.
 * The platform behaviour is not conditional — it is the default argument, and
 * the on-device tests exercise it unchanged.
 */
interface DurableFiles {

    /** Create [directory] and every missing level above it, each new entry made
     *  durable in its own parent. */
    fun createDirectories(directory: File)

    /** Replace [file]'s contents atomically and durably. */
    fun writeAtomically(file: File, bytes: ByteArray)

    /** Make [directory]'s own entries durable. */
    fun syncDirectory(directory: File)

    /** Flush a stream's bytes to the storage device. */
    fun syncStream(out: FileOutputStream)

    companion object {
        /** What the app always uses. */
        val Platform: DurableFiles = PlatformDurableFiles
    }
}

private object PlatformDurableFiles : DurableFiles {
    override fun createDirectories(directory: File) = createDirectoryDurably(directory)
    override fun writeAtomically(file: File, bytes: ByteArray) = writeFileAtomically(file, bytes)
    override fun syncDirectory(directory: File) = com.relayium.android.cloud.syncDirectory(directory)
    override fun syncStream(out: FileOutputStream) {
        out.flush()
        out.fd.sync()
    }
}

/**
 * Create a directory and every missing level above it, making each new entry
 * durable in its OWN parent.
 *
 * `mkdirs` followed by an fsync of the leaf is not enough: each level is an
 * entry in the level above, and syncing a child says nothing about whether the
 * parent's entry for it survived. A stored-link key written into a freshly
 * created account directory could otherwise be reported as committed — which
 * licenses deleting the pending job that holds the only other copy of the key —
 * while the directory entry naming it was still only in the page cache.
 */
internal fun createDirectoryDurably(directory: File) {
    if (directory.isDirectory) return
    val missing = ArrayList<File>()
    var level: File? = directory
    while (level != null && !level.isDirectory) {
        missing.add(level)
        level = level.parentFile
    }
    if (level == null) throw IOException("the directory has no existing ancestor")
    // Outermost first, so each mkdir happens inside a directory that exists,
    // and each new entry is synced in the parent that now names it.
    for (target in missing.asReversed()) {
        if (!target.mkdir() && !target.isDirectory) {
            throw IOException("the directory could not be created")
        }
        syncDirectory(target.parentFile ?: throw IOException("no parent directory"))
    }
}

/**
 * Make a directory's own entries durable.
 *
 * A rename, a create and a delete are directory writes, and none of them is
 * covered by an `fsync` on the file that moved. Every durability claim this
 * feature makes — the attempt marker exists before finalize is requested, a job
 * with no plan is an incomplete staging — is a claim about directory entries.
 *
 * `O_DIRECTORY` is not exposed by the compile SDK, so the descriptor is opened
 * read-only and its type is CHECKED with `fstat` before it is synced: syncing
 * whatever a path happens to resolve to is not the same operation.
 */
internal fun syncDirectory(directory: File) {
    val fd = try {
        Os.open(directory.path, OsConstants.O_RDONLY, 0)
    } catch (e: ErrnoException) {
        throw IOException("the directory could not be opened for sync", e)
    }
    try {
        if (!OsConstants.S_ISDIR(Os.fstat(fd).st_mode)) {
            throw IOException("the path being synced is not a directory")
        }
        Os.fsync(fd)
    } catch (e: ErrnoException) {
        throw IOException("the directory could not be synced", e)
    } finally {
        try {
            Os.close(fd)
        } catch (_: ErrnoException) {
            // A failed close leaks one descriptor; the sync above is what
            // mattered and is not worth failing a durable write over.
        }
    }
}
