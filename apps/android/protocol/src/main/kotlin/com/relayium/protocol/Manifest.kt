package com.relayium.protocol

/**
 * One file in a batch.
 *
 * `size` is a `Long` and the manifest carries it as a JSON number, so it is
 * bounded by JavaScript's exact-integer range on the wire — the browser cannot
 * represent more and would silently round. [ManifestCodec] enforces that bound
 * rather than letting a 2^60 size through to an allocation.
 *
 * `path` is the relative path within a sent folder, absent for a flat file. It
 * is peer-controlled and is NOT safe to join onto a destination until
 * [Filename.resolveRelativePath] has accepted it.
 */
data class FileMeta(val name: String, val size: Long, val path: String? = null)

/** A manifest that cannot be trusted, with the reason. */
class ManifestException(message: String) : RuntimeException(message)

/**
 * The `BATCH_ENC` payload: `{"files":[{"name","size","path"?}]}`.
 *
 * Key order is `name`, `size`, `path`, and `path` is OMITTED when absent rather
 * than sent as null. That is not cosmetic — `web/scripts/gen-realtime-wire-vectors.mjs`
 * builds the golden `batchFrameHex` from exactly this shape, so a different key
 * order or an explicit null produces different ciphertext and the conformance
 * suite fails.
 */
object ManifestCodec {

    /** Files in one manifest. */
    const val MAX_FILES = 1000

    /** UTF-8 bytes of a name or a path. */
    const val MAX_NAME_BYTES = 1024

    /** JavaScript's exact-integer ceiling. A size above it cannot round-trip. */
    const val MAX_SAFE_SIZE = 9_007_199_254_740_991L

    fun encode(files: List<FileMeta>): ByteArray {
        val items = files.map { file ->
            val entry = LinkedHashMap<String, Json>()
            entry["name"] = Json.of(file.name)
            entry["size"] = Json.of(file.size)
            file.path?.let { entry["path"] = Json.of(it) }
            Json.Obj(entry)
        }
        return Json.stringify(Json.obj("files" to Json.arr(items))).toByteArray(Charsets.UTF_8)
    }

    /**
     * Decode and VALIDATE, then sanitise.
     *
     * Encryption authenticates the sender, not the sender's numbers, so every
     * receive path crosses this boundary before it displays or writes anything.
     * The order matters: validate the untrusted shape first, then sanitise names
     * at this single entry point so every downstream consumer — the receive
     * card, the progress row, the on-disk name — sees the cleaned value.
     */
    @Throws(ManifestException::class)
    fun decode(plaintext: ByteArray): List<FileMeta> {
        val text = try {
            decodeUtf8Strict(plaintext)
        } catch (_: CharacterCodingException) {
            throw ManifestException("relayium: manifest is not valid UTF-8")
        }
        val root = Json.parseOrNull(text) as? Json.Obj
            ?: throw ManifestException("relayium: manifest is not a JSON object")
        val array = root["files"] as? Json.Arr
            ?: throw ManifestException("relayium: manifest has no files array")
        if (array.items.isEmpty()) throw ManifestException("relayium: manifest is empty")
        if (array.items.size > MAX_FILES) {
            throw ManifestException("relayium: manifest names ${array.items.size} files, over $MAX_FILES")
        }
        var total = 0L
        val files = ArrayList<FileMeta>(array.items.size)
        for (entry in array.items) {
            val obj = entry as? Json.Obj ?: throw ManifestException("relayium: invalid manifest entry")
            val name = (obj["name"] as? Json.Str)?.value
                ?: throw ManifestException("relayium: manifest entry has no name")
            if (name.isEmpty()) throw ManifestException("relayium: manifest entry has an empty name")
            if (utf8Length(name) > MAX_NAME_BYTES) {
                throw ManifestException("relayium: manifest file name is longer than $MAX_NAME_BYTES bytes")
            }
            val sizeNum = (obj["size"] as? Json.Num)?.value
                ?: throw ManifestException("relayium: manifest entry has no size")
            if (!sizeNum.isFinite() || sizeNum < 0 || sizeNum > MAX_SAFE_SIZE.toDouble() ||
                sizeNum.toLong().toDouble() != sizeNum
            ) {
                throw ManifestException("relayium: manifest file size is not a safe non-negative integer")
            }
            val path = when (val raw = obj["path"]) {
                null, is Json.Null -> null
                is Json.Str -> raw.value.also {
                    if (utf8Length(it) > MAX_NAME_BYTES) {
                        throw ManifestException("relayium: manifest path is longer than $MAX_NAME_BYTES bytes")
                    }
                }
                else -> throw ManifestException("relayium: manifest path is not a string")
            }
            // Checked as it accumulates, not at the end: the point is to refuse
            // BEFORE anything allocates against the total, and a sum that
            // overflows into a small number would pass an end check.
            total += sizeNum.toLong()
            if (total < 0 || total > MAX_SAFE_SIZE) {
                throw ManifestException("relayium: manifest total size is out of range")
            }
            files.add(FileMeta(name, sizeNum.toLong(), path))
        }
        return Filename.sanitizeNames(files)
    }

    /**
     * The `DONE_ENC` payload: `{"sha256":<hex>}`, carrying the file's CHAINED
     * digest — `h = SHA-256(h || chunk)` over logical chunks — not a plain
     * SHA-256 of the contents.
     */
    fun encodeDone(chainHex: String): ByteArray =
        Json.stringify(Json.obj("sha256" to Json.of(chainHex))).toByteArray(Charsets.UTF_8)

    fun decodeDone(plaintext: ByteArray): String? {
        val text = try {
            decodeUtf8Strict(plaintext)
        } catch (_: CharacterCodingException) {
            return null
        }
        val obj = Json.parseOrNull(text) as? Json.Obj ?: return null
        val hex = (obj["sha256"] as? Json.Str)?.value ?: return null
        // 32 bytes of lower-case hex, and nothing else. A comparison against a
        // differently-cased or differently-shaped string would be a mismatch
        // reported as corruption, which is a confusing way to fail.
        if (hex.length != 64 || hex.any { it !in '0'..'9' && it !in 'a'..'f' }) return null
        return hex
    }

    private fun utf8Length(value: String): Int = value.toByteArray(Charsets.UTF_8).size
}

/** Thrown by strict UTF-8 decoding. */
class CharacterCodingException(message: String) : RuntimeException(message)

/**
 * Decode UTF-8 with NO replacement.
 *
 * `String(bytes, UTF_8)` silently substitutes U+FFFD, which is corruption
 * reported as success — the one outcome `relayium-text-v1.md` forbids by name.
 * Every place this protocol turns bytes into text goes through here.
 */
internal fun decodeUtf8Strict(bytes: ByteArray): String {
    val decoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
        .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
    return try {
        decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString()
    } catch (e: java.nio.charset.CharacterCodingException) {
        // The byte LENGTH, never the bytes: this message reaches logs and the UI.
        throw CharacterCodingException("relayium: not valid UTF-8 (${bytes.size} bytes)")
    }
}
