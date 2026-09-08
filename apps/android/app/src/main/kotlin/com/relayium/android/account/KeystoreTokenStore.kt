package com.relayium.android.account

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.io.FileOutputStream
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The bearer, wrapped by an `AndroidKeyStore` AES-GCM key and written where
 * Android's backup machinery cannot reach it.
 *
 * ## Two separate protections, and why each one is needed
 *
 * **The key never leaves the keystore.** `AndroidKeyStore` generates it inside
 * the platform's key store and this process only ever holds a `SecretKey`
 * HANDLE — the key material is not readable by this app, so a copy of the
 * ciphertext file taken off the device (a `run-as` on a debuggable build, a
 * filesystem image, a rooted read) decrypts to nothing without that device's
 * key store.
 * (https://developer.android.com/privacy-and-security/keystore)
 *
 * It is deliberately NOT described as hardware-backed. Whether the key lives in
 * a TEE, a secure element or a software keymaster implementation is a property
 * of the DEVICE, not of this code: an AOSP emulator image — the one every
 * acceptance in this repository runs on — has a software-backed key store, and
 * the same call sequence produces a key with materially weaker guarantees
 * there. This class cannot promise what it does not check, and nothing here
 * queries `KeyInfo.isInsideSecureHardware`, so the honest claim is the one
 * made above: the key is held by the platform key store rather than by this
 * app. Requiring secure hardware would be a separate, user-visible decision —
 * it would make the credential unstorable on devices that lack it.
 *
 * **The ciphertext lives in `noBackupFilesDir`.** The manifest already sets
 * `allowBackup="false"`, but that is one flag in one file: `noBackupFilesDir`
 * is the platform's own statement that a path is excluded from backup and from
 * device-to-device transfer, and it does not depend on a manifest attribute
 * staying correct through a future edit. It also matters even when a backup DID
 * happen: the keystore key is not backed up either, so a restored ciphertext is
 * inert — but an inert blob that looks like a credential is exactly the thing
 * that produces a confusing "signed in as nobody" state on a new phone.
 *
 * ## Atomic replacement
 *
 * A write goes to a temporary file in the same directory, is flushed to the
 * storage device with `fd.sync()`, and only then replaces the real one. So the
 * live file is at every instant either the previous complete credential or the
 * new complete credential, never a half-written blob — which would be
 * indistinguishable from a corrupted one and would cost the user their session
 * because the process was killed mid-`save`.
 *
 * ## What a failure means
 *
 * Every path throws [TokenStoreException] rather than degrading. A keystore
 * that will not generate a key (a device with a broken or disabled secure
 * hardware stack), a disk that is full, a decrypt that fails because the key
 * was invalidated by a factory reset or a lock-screen change — each of those is
 * a fact the user needs, and each has a different honest recovery. See
 * [TokenStore] for why none of them is silently turned into "no token here".
 */
class KeystoreTokenStore(context: Context) : TokenStore {

    private val file = File(File(context.noBackupFilesDir, DIRECTORY), FILE_NAME)

    override fun save(token: String) {
        val key = try {
            secretKey()
        } catch (e: GeneralSecurityException) {
            throw TokenStoreException("the credential could not be wrapped: no usable keystore key", e)
        }
        val sealed = try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            // The IV is the one the KEYSTORE chose. `setRandomizedEncryptionRequired`
            // refuses a caller-supplied one outright, which is the correct
            // refusal: reusing a nonce under one AES-GCM key destroys the
            // integrity of every message under it.
            val iv = cipher.iv
            val plain = token.toByteArray(Charsets.UTF_8)
            val body = try {
                cipher.doFinal(plain)
            } finally {
                // The plaintext copy this method made, overwritten as soon as it
                // is no longer needed, so a heap dump taken later does not find
                // the credential sitting in a stale array. It is a bound on the
                // window, not a guarantee: the `String` it came from is
                // immutable and the JVM may have copied either of them, which is
                // exactly why this is done where it is cheap and not claimed to
                // be more than it is.
                plain.fill(0)
            }
            require(iv.size in 1..255) { "unexpected IV length" }
            ByteArray(2 + iv.size + body.size).also { out ->
                out[0] = FORMAT_VERSION
                out[1] = iv.size.toByte()
                System.arraycopy(iv, 0, out, 2, iv.size)
                System.arraycopy(body, 0, out, 2 + iv.size, body.size)
            }
        } catch (e: GeneralSecurityException) {
            throw TokenStoreException("the credential could not be wrapped", e)
        }
        writeAtomically(sealed)
    }

    override fun load(): String? {
        val sealed = try {
            if (!file.isFile) return null
            // BOUNDED. `readBytes` on a path this app does not fully control —
            // a device where something else can write into the app's data
            // directory, a partially-restored image — would otherwise size its
            // buffer from the file. The ceiling is far above a real record
            // (a header, a 12-byte IV, and a token capped at
            // [Bearer.MAX_LENGTH] plus a 16-byte tag), so nothing legitimate is
            // near it, and a file over it is refused rather than buffered.
            if (file.length() > MAX_SEALED_BYTES) {
                throw TokenStoreException("the stored credential is larger than this build will read")
            }
            file.readBytes()
        } catch (e: java.io.IOException) {
            throw TokenStoreException("the stored credential could not be read", e)
        }
        // A blob too short to hold a header cannot be one of ours. It is still
        // an ERROR rather than "nothing here": something occupies the path, and
        // reporting absence would let the next save overwrite it silently.
        if (sealed.size < 3 || sealed[0] != FORMAT_VERSION) {
            throw TokenStoreException("the stored credential is not in a format this build can read")
        }
        val ivLength = sealed[1].toInt() and 0xFF
        if (ivLength == 0 || sealed.size <= 2 + ivLength) {
            throw TokenStoreException("the stored credential is truncated")
        }
        val key = try {
            existingKey()
        } catch (e: GeneralSecurityException) {
            throw TokenStoreException("the keystore key for this credential is unavailable", e)
        } ?: throw TokenStoreException("the keystore key for this credential no longer exists")
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                key,
                GCMParameterSpec(TAG_BITS, sealed, 2, ivLength),
            )
            val plain = cipher.doFinal(sealed, 2 + ivLength, sealed.size - 2 - ivLength)
            try {
                String(plain, Charsets.UTF_8)
            } finally {
                plain.fill(0)
            }
        } catch (e: GeneralSecurityException) {
            // Includes AEADBadTagException: the file was altered, or the key was
            // invalidated. Both mean the credential is gone, and neither is
            // "there was never one".
            throw TokenStoreException("the stored credential could not be unwrapped", e)
        }
    }

    override fun clear() {
        // Deleting the ciphertext is what makes the credential unrecoverable —
        // the keystore key alone opens nothing. The KEY is deleted too, so a
        // later blob cannot be decrypted by a key this account's sign-out was
        // supposed to end, but that deletion is best-effort and deliberately
        // NOT what success is judged on: the file is.
        val deleted = !file.exists() || file.delete()
        runCatching { keyStore().deleteEntry(ALIAS) }
        if (!deleted || file.exists()) {
            throw TokenStoreException("the stored credential could not be removed from this device")
        }
    }

    private fun writeAtomically(bytes: ByteArray) {
        val directory = file.parentFile
            ?: throw TokenStoreException("the credential directory could not be resolved")
        if (!directory.isDirectory && !directory.mkdirs()) {
            throw TokenStoreException("the credential directory could not be created")
        }
        val temporary = File(directory, "$FILE_NAME.tmp")
        try {
            FileOutputStream(temporary).use { out ->
                out.write(bytes)
                out.flush()
                // The rename below is atomic with respect to a CRASH, not with
                // respect to a power loss: without this the renamed name can
                // become visible while the bytes are still in the page cache.
                out.fd.sync()
            }
            if (!temporary.renameTo(file)) {
                throw TokenStoreException("the credential could not be moved into place")
            }
        } catch (e: java.io.IOException) {
            throw TokenStoreException("the credential could not be written to this device", e)
        } finally {
            // A leftover temporary is not a credential anyone can use — it is
            // the same ciphertext — but it must not accumulate.
            if (temporary.exists()) temporary.delete()
        }
    }

    private fun keyStore(): KeyStore =
        KeyStore.getInstance(PROVIDER).apply { load(null) }

    private fun existingKey(): SecretKey? =
        keyStore().getKey(ALIAS, null) as? SecretKey

    private fun secretKey(): SecretKey = existingKey() ?: generateKey()

    private fun generateKey(): SecretKey {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // No user-authentication requirement: this app has no screen
                // lock of its own and asking the platform for one would make the
                // credential unreadable on a device with no secure lock at all
                // — turning a privacy improvement into "you cannot sign in".
                .setUserAuthenticationRequired(false)
                // Refuse a caller-supplied IV. See `save`.
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val PROVIDER = "AndroidKeyStore"
        const val ALIAS = "com.relayium.android.account.bearer.v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
        const val DIRECTORY = "account"
        const val FILE_NAME = "bearer.v1.bin"

        /** Two header bytes, an IV, a bounded token and a 16-byte GCM tag, with
         *  generous room to spare. See the bounded read in [load]. */
        const val MAX_SEALED_BYTES = 4L * 1024

        /** Bumped only if the framing changes. An unknown version is refused,
         *  never guessed at — see [load]. */
        const val FORMAT_VERSION: Byte = 1
    }
}
