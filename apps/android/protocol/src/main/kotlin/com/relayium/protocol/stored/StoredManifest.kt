package com.relayium.protocol.stored

import com.relayium.protocol.Crypto
import com.relayium.protocol.FileMeta
import com.relayium.protocol.Filename
import com.relayium.protocol.Json
import com.relayium.protocol.JsonException
import com.relayium.protocol.ManifestCodec
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.GeneralSecurityException

/** The largest size the manifest JSON can carry exactly: JavaScript's
 *  `Number.MAX_SAFE_INTEGER`, because the Web writes and reads these numbers. */
const val MANIFEST_MAX_SAFE_INTEGER = 9_007_199_254_740_991L

/** One entry, RAW as the sender wrote it. Sanitising happens at the display
 *  boundary and nowhere else — see [decryptManifestRaw]. */
data class ManifestFile(val name: String, val size: Long)

/** What a stored object contains, as its uploader described it. */
data class StoredManifest(val files: List<ManifestFile>)

/**
 * The manifest as seq-0 plaintext: compact JSON, no spaces, key order
 * `files`, `name`, `size`.
 *
 * Byte-exactness is the whole contract. These bytes are what the GCM tag
 * covers, so a manifest that serialises differently — a space, a reordered key,
 * a `1.0` where `1` belongs — produces ciphertext the Web and Swift readers
 * reject outright. [Json] is the module's own writer and already renders
 * `JSON.stringify` semantics (insertion-ordered keys, integral numbers with no
 * fraction, JS string escaping), which is why this composes it rather than
 * formatting a string by hand.
 */
fun encodeManifestJson(manifest: StoredManifest): ByteArray {
    val files = manifest.files.map { file ->
        Json.obj("name" to Json.of(file.name), "size" to Json.of(file.size))
    }
    return Json.stringify(Json.obj("files" to Json.arr(files))).toByteArray(Charsets.UTF_8)
}

/**
 * Everything a receiver must believe before it plans a single destination.
 *
 * Runs on the RAW names, and on both sides of the wire: a sender that would
 * produce an unusable manifest is stopped before it spends an upload, and a
 * received manifest is refused before it can steer file creation.
 *
 * The total is capped at [MANIFEST_MAX_SAFE_INTEGER] on every step, not only at
 * the end, so a manifest that sums past the cap is refused before it reaches an
 * allocation or a progress calculation.
 */
fun validateManifestFiles(files: List<ManifestFile>): Long {
    if (files.isEmpty() || files.size > ManifestCodec.MAX_FILES) {
        storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
    }
    var total = 0L
    for (file in files) {
        val nameBytes = file.name.toByteArray(Charsets.UTF_8).size
        if (file.name.isEmpty() || nameBytes > ManifestCodec.MAX_NAME_BYTES) {
            storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
        }
        if (file.size < 0 || file.size > MANIFEST_MAX_SAFE_INTEGER) {
            storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
        }
        total += file.size
        if (total > MANIFEST_MAX_SAFE_INTEGER) {
            storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
        }
    }
    return total
}

/** Validate, then seal at seq 0. */
fun encryptManifest(key: ByteArray, manifest: StoredManifest): ByteArray {
    validateManifestFiles(manifest.files)
    return Crypto.seal(storeKeySpec(key), 0L, encodeManifestJson(manifest))
}

/**
 * Decrypt and validate, keeping every name EXACTLY as the sender wrote it.
 *
 * The raw form is what a receiver planning destinations must use.
 * [displayNames] strips control and bidi characters, which is right for a name
 * a person is about to read and wrong for one about to become a filesystem
 * instruction: stripping a control character out of a name yields something
 * this device would then happily create, when the honest answer is to refuse
 * the entry. [Filename.resolveRelativePath] is where that refusal lives, and it
 * can only refuse what it receives unmodified.
 */
fun decryptManifestRaw(key: ByteArray, ciphertext: ByteArray): StoredManifest {
    val plaintext = try {
        Crypto.open(storeKeySpec(key), 0L, ciphertext)
    } catch (_: GeneralSecurityException) {
        storedFailure(StoredWireException.Reason.TRUNCATED_STREAM)
    }
    // STRICT UTF-8. `ByteArray.toString(UTF_8)` substitutes U+FFFD for malformed
    // input, which would let a mangled manifest reach the parser looking like
    // plausible text — and, worse, let a name that is not valid UTF-8 become a
    // different name that path validation then approves. The bytes either are
    // what the sender wrote or they are not this manifest.
    val text = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(plaintext))
            .toString()
    } catch (_: CharacterCodingException) {
        storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
    }
    val parsed = try {
        Json.parse(text)
    } catch (_: JsonException) {
        storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
    }
    val root = parsed as? Json.Obj ?: storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
    val array = root["files"] as? Json.Arr ?: storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
    // Bounded BEFORE the entries are materialised. `validateManifestFiles`
    // refuses an over-long list too, but only after building every entry.
    if (array.items.size > ManifestCodec.MAX_FILES) {
        storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
    }
    val files = array.items.map { item ->
        val entry = item as? Json.Obj ?: storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
        val name = (entry["name"] as? Json.Str)?.value
            ?: storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
        val size = (entry["size"] as? Json.Num)?.value
            ?: storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
        // A non-integral or out-of-range size is refused, never rounded: it is
        // the number the truncation check is measured against, so a value this
        // reader had to reinterpret would make that check meaningless.
        if (size.isNaN() || size != Math.floor(size) ||
            size < 0 || size > MANIFEST_MAX_SAFE_INTEGER.toDouble()
        ) {
            storedFailure(StoredWireException.Reason.INVALID_MANIFEST)
        }
        ManifestFile(name, size.toLong())
    }
    validateManifestFiles(files)
    return StoredManifest(files)
}

/** The names as a person should SEE them. Never as a destination. */
fun StoredManifest.displayNames(): List<String> =
    files.map { Filename.safeDisplayName(it.name) }

/**
 * The receiver's view of a stored manifest, in the shape the destination
 * planner already speaks.
 *
 * A stored entry carries ONE string, and a folder upload encodes hierarchy in
 * it as a forward-slash relative path — the convention the Go CLI writes and
 * the Web reads. `FileMeta` splits that into a leaf and a path, which is
 * exactly what [Filename.resolveRelativePath] takes, so a stored download and a
 * realtime one reach the receive store through the same rules and the same
 * refusals. Names stay RAW here for the reason [decryptManifestRaw] gives.
 */
fun StoredManifest.asFileMetas(): List<FileMeta> = files.map { file ->
    val path = if (file.name.contains('/')) file.name else null
    val leaf = if (path == null) file.name else file.name.substringAfterLast('/')
    FileMeta(name = leaf, size = file.size, path = path)
}
