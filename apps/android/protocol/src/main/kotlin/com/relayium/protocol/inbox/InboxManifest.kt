package com.relayium.protocol.inbox

import com.relayium.protocol.Crypto
import com.relayium.protocol.Json
import com.relayium.protocol.JsonException
import com.relayium.protocol.stored.StoredWireException
import com.relayium.protocol.stored.storeKeySpec
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.GeneralSecurityException

/**
 * The Device Inbox v3 encrypted manifest — the small authenticated JSON document
 * a sender seals at frame 0 of a delivery, describing what the frames after it
 * contain.
 *
 * This is the Kotlin fourth of one codec. The others are
 * `server/internal/inboxmanifest`, `web/src/lib/inbox-manifest.ts` and
 * RelayiumKit's `InboxManifest.swift`, and all four are checked against the same
 * frozen vectors in `apps/RelayiumKit/Tests/Fixtures/device-inbox-manifest-v3-vectors.json`.
 *
 * It is DELIBERATELY separate from [com.relayium.protocol.stored.StoredManifest],
 * the shared Stored-Wire manifest. Those bytes are frozen and interop-tested
 * across unrelated products; teaching them a content kind would change what a
 * public share object looks like. This one is free to be stricter, and is — so
 * a v1 `{"files":[…]}` document must fail here as an unsupported VERSION rather
 * than be quietly read by the v1 codec as a nameless file.
 *
 * **Invariants.**
 *
 *  1. KIND IS SEALED. Content kind exists here and nowhere else. Central holds
 *     ciphertext, so a message and a file delivery are indistinguishable to it,
 *     to its logs, and to its operators.
 *  2. ONE KIND PER DELIVERY. A mixed manifest is refused, not partly honoured:
 *     a receiver would otherwise have to write half a delivery into the user's
 *     receive folder and half into a message store.
 *  3. CANONICAL OR REFUSED. There is exactly ONE byte sequence per manifest.
 *     [decode] re-encodes what it parsed and requires byte equality, so
 *     reordered keys, duplicates, whitespace and dropped fields are refusals.
 *  4. AEAD IS NOT VALIDATION. Decryption proves who wrote the bytes and says
 *     nothing about whether their numbers and names are safe to act on.
 *  5. TEXT IS NOT IN HERE. A message's bytes travel in the encrypted frames like
 *     any other payload; the manifest carries only its length.
 */
object InboxManifest {

    /**
     * The only manifest version this codec reads or writes.
     *
     * v1 had no version field at all — it was `{"files":[…]}`, the shared
     * Stored-Wire shape. That is why the version is checked FIRST and why its
     * absence is a refusal: a v1 document must fail as an unsupported version,
     * not as a manifest with no items.
     */
    const val VERSION = 3

    /** Item-count bounds. The maximum matches the shared manifest's, so a folder
     *  that can be shared can also be sent to a device. */
    const val MAX_ITEMS = 1000
    const val MIN_ITEMS = 1

    /** One file name, in UTF-8 BYTES: the filesystem limit this eventually meets
     *  is a byte limit, not a character one. */
    const val MAX_NAME_BYTES = 1024

    /** "/"-separated components in one name. A name may be a relative path so a
     *  folder send keeps its shape; this stops a thousand-deep demanded tree. */
    const val MAX_PATH_DEPTH = 64

    /** JavaScript's exact-integer ceiling, and therefore the protocol's: one of
     *  the implementations of this codec runs in a browser, and a size only
     *  Kotlin and Go could hold exactly would decode differently there. */
    const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    /** Message length bounds, in UTF-8 bytes of the message itself. 1 because an
     *  empty message is not a message; 65536 because that is far more than
     *  anyone types and small enough to hold in memory to display. */
    const val MIN_TEXT_BYTES = 1L
    const val MAX_TEXT_BYTES = 65536L

    // ── construction ────────────────────────────────────────────────────────

    /** A validated file manifest. The constructors exist so no caller assembles
     *  a value and skips the bounds. */
    fun files(entries: List<Pair<String, Long>>): InboxManifestV3 =
        InboxManifestV3(entries.map { (name, size) -> InboxManifestItem.file(name, size) })
            .also(::validate)

    /** The one-item manifest for a message of [size] UTF-8 bytes. */
    fun text(size: Long): InboxManifestV3 =
        InboxManifestV3(listOf(InboxManifestItem.text(size))).also(::validate)

    // ── validation ──────────────────────────────────────────────────────────

    /**
     * Apply every bound, in a fixed order, and throw on the FIRST violation.
     *
     * The order is part of the contract, matched by the Go, TypeScript and Swift
     * codecs: shape, then per-item rules, then the aggregate — so a document is
     * reported by the rule it broke first and all four implementations name the
     * same one.
     */
    fun validate(manifest: InboxManifestV3) {
        val items = manifest.items
        if (items.size < MIN_ITEMS || items.size > MAX_ITEMS) fail(InboxManifestReason.ITEM_COUNT)

        // Checked against item 0 rather than against a permitted set, so "all
        // text except one file" and "all files except one text" are refused by
        // the same rule.
        val kind = items[0].kind
        if (items.any { it.kind != kind }) fail(InboxManifestReason.MIXED_KINDS)

        if (kind == InboxManifestKind.TEXT) {
            // One message per delivery. A second text item would have no way to
            // be told apart from the first in the frame stream, since text
            // carries no name — the receiver would have to guess the boundary.
            if (items.size != 1) fail(InboxManifestReason.TEXT_ITEM_COUNT)
            val item = items[0]
            if (item.name != null) fail(InboxManifestReason.TEXT_NAME)
            if (item.size < MIN_TEXT_BYTES || item.size > MAX_TEXT_BYTES) {
                fail(InboxManifestReason.SIZE)
            }
            return
        }

        var total = 0L
        for (item in items) {
            val name = item.name
            if (name == null || !isAcceptableName(name)) fail(InboxManifestReason.NAME)
            // Zero is legal — an empty file is a real file — but negative is
            // not, and neither is a value a browser could not hold exactly.
            if (item.size < 0 || item.size > MAX_SAFE_INTEGER) fail(InboxManifestReason.SIZE)
            // Checked on every step rather than only at the end, so a manifest
            // that sums past the cap is refused before any allocation or
            // progress calculation is derived from it.
            total += item.size
            if (total > MAX_SAFE_INTEGER) fail(InboxManifestReason.TOTAL_OVERFLOW)
        }
    }

    /**
     * The traversal-and-control rule, deliberately PLATFORM-NEUTRAL: exactly
     * these names are accepted on every receiver, so one manifest is accepted or
     * refused identically everywhere. A name that only some of a user's devices
     * would take is worse than one none of them would.
     *
     * Platform-specific hardening — Windows reserved device names, components
     * ending in a dot or a space, case-insensitive collisions, SAF display-name
     * rules — belongs to the RECEIVER's destination planner, which knows the
     * filesystem it is about to write to. Those checks run after this one, never
     * instead of it; on Android that is
     * [com.relayium.protocol.Filename.resolveRelativePath] and
     * [com.relayium.protocol.stored.StoredDestinations], which this codec
     * deliberately does not call: the manifest rule must not vary by receiver.
     *
     * Refused here: empty or over [MAX_NAME_BYTES]; any C0 control or DEL, which
     * can truncate a C string or rewrite a terminal line as the name is logged or
     * displayed; a backslash anywhere, because "/" is the separator by protocol
     * and a backslash means "separator" on Windows; a leading "/" or a drive
     * prefix, both of which leave the receive folder entirely; and any "", "." or
     * ".." component, which is traversal.
     */
    fun isAcceptableName(name: String): Boolean {
        // A lone UTF-16 surrogate has NO UTF-8 spelling, so a name carrying one
        // has no canonical byte sequence to compare against and cannot be a
        // filesystem name anywhere. It can only arrive through a `\udXXX` escape,
        // which strict UTF-8 input can never produce; refusing it here keeps
        // invariant 3 total rather than leaving a document whose "canonical"
        // form depends on how the encoder substitutes.
        if (!isWellFormedUtf16(name)) return false

        val bytes = name.toByteArray(Charsets.UTF_8)
        if (bytes.isEmpty() || bytes.size > MAX_NAME_BYTES) return false
        if (name.any { it.code < 0x20 || it.code == 0x7f }) return false
        if (name.contains('\\')) return false
        if (bytes[0] == '/'.code.toByte()) return false
        // "C:foo" is drive-relative and "C:/foo" drive-absolute on Windows; both
        // escape a receive folder there while looking ordinary here. Measured in
        // BYTES, so a two-byte first character (`é:1.txt`) is not a drive prefix.
        if (bytes.size >= 2 && bytes[1] == ':'.code.toByte()) return false
        val parts = name.split('/')
        if (parts.size > MAX_PATH_DEPTH) return false
        return parts.none { it.isEmpty() || it == "." || it == ".." }
    }

    private fun isWellFormedUtf16(text: String): Boolean {
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= text.length || !Character.isLowSurrogate(text[i + 1])) return false
                i += 2
                continue
            }
            if (Character.isLowSurrogate(c)) return false
            i++
        }
        return true
    }

    // ── the canonical form ──────────────────────────────────────────────────

    /**
     * The ONE canonical byte sequence for [manifest], after validating it.
     *
     * The rules: no whitespace, fixed key order (`v`, `items`; then `kind`,
     * `name`, `size`), `name` omitted entirely for text, `"` `\` and the C0
     * controls escaped (`\b \t \n \f \r` by name, the rest as lowercase
     * `\u00xx`), everything else — DEL, C1 controls, bidi overrides, U+2028/9 and
     * all non-ASCII — emitted raw as UTF-8, and `/` never escaped.
     *
     * That is exactly what [Json] already writes: insertion-ordered keys,
     * integral numbers with no fraction, and `JSON.stringify` escaping. Composing
     * it rather than formatting a string by hand is what keeps this encoder and
     * the module's other MAC'd payloads on one escaper. Go's encoder escapes
     * `<`, `>`, `&` and U+2028/9 where JavaScript does not, which is why all four
     * implementations write these bytes deliberately rather than by default.
     */
    fun encode(manifest: InboxManifestV3): ByteArray {
        validate(manifest)
        val items = manifest.items.map { item ->
            when (item.kind) {
                InboxManifestKind.FILE -> Json.obj(
                    "kind" to Json.of(item.kind.wire),
                    "name" to Json.of(item.name ?: ""),
                    "size" to Json.of(item.size),
                )
                InboxManifestKind.TEXT -> Json.obj(
                    "kind" to Json.of(item.kind.wire),
                    "size" to Json.of(item.size),
                )
            }
        }
        val document = Json.obj("v" to Json.of(VERSION), "items" to Json.arr(items))
        return Json.stringify(document).toByteArray(Charsets.UTF_8)
    }

    // ── decoding ────────────────────────────────────────────────────────────

    /**
     * Parse, validate, and refuse anything that is not the canonical spelling of
     * what was parsed (invariant 3).
     *
     * The canonical re-encode is what makes this strict without a second
     * hand-written parser: a duplicate `"size"` key where the last wins,
     * `{"items":…,"v":3}` in the wrong order, a trailing newline, a `1e3` size
     * and an escaped `\/` are all things a permissive parser absorbs silently
     * and the re-encode catches.
     */
    fun decode(data: ByteArray): InboxManifestV3 {
        // STRICT UTF-8. `ByteArray.toString(UTF_8)` substitutes U+FFFD for
        // malformed input, which would let a name that is not valid UTF-8 become
        // a DIFFERENT name that the rules above then approve.
        val text = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(data))
                .toString()
        } catch (_: CharacterCodingException) {
            fail(InboxManifestReason.MALFORMED)
        }
        val parsed = try {
            Json.parse(text)
        } catch (_: JsonException) {
            fail(InboxManifestReason.MALFORMED)
        }
        val root = parsed as? Json.Obj ?: fail(InboxManifestReason.MALFORMED)

        // The version is read FIRST, and that ordering is part of the contract
        // rather than an accident. A v1 document is `{"files":[…]}` — no `v` at
        // all. Refused by the unknown-key check below it would be "unknown
        // field: files", which is true and useless; refused here it is
        // "unsupported version", which a person can act on.
        val rawVersion = root["v"] ?: fail(InboxManifestReason.VERSION)
        val declared = exactInt(rawVersion) ?: fail(InboxManifestReason.MALFORMED)
        if (declared != VERSION.toLong()) fail(InboxManifestReason.VERSION)

        if (root.keys.any { it != "v" && it != "items" }) fail(InboxManifestReason.MALFORMED)
        val rawItems = root["items"] ?: fail(InboxManifestReason.ITEM_COUNT)
        val entries = (rawItems as? Json.Arr)?.items ?: fail(InboxManifestReason.MALFORMED)

        // A structural pass over EVERY entry before any semantic rule, matching
        // the Go decoder, where types and unknown fields are settled by the
        // decoder itself before validation begins. Without this the two would
        // disagree about which complaint a doubly-broken document earns.
        val items = entries.map { entry ->
            val item = entry as? Json.Obj ?: fail(InboxManifestReason.MALFORMED)
            if (item.keys.any { it != "kind" && it != "name" && it != "size" }) {
                fail(InboxManifestReason.MALFORMED)
            }
            val rawKind = item["kind"] ?: fail(InboxManifestReason.UNKNOWN_KIND)
            val kindText = (rawKind as? Json.Str)?.value ?: fail(InboxManifestReason.MALFORMED)
            val kind = InboxManifestKind.fromWire(kindText)
                ?: fail(InboxManifestReason.UNKNOWN_KIND)
            val name = item["name"]?.let {
                (it as? Json.Str)?.value ?: fail(InboxManifestReason.MALFORMED)
            }
            val size = item["size"]?.let(::exactInt) ?: fail(InboxManifestReason.MALFORMED)
            InboxManifestItem(kind, name, size)
        }

        val manifest = InboxManifestV3(items)
        validate(manifest)
        if (!encode(manifest).contentEquals(data)) fail(InboxManifestReason.NOT_CANONICAL)
        return manifest
    }

    /**
     * An exact integer, or null.
     *
     * [Json] keeps every number as the double JavaScript reads it as, which is
     * what makes this side's idea of a size identical to the browser's. A
     * non-integral or non-finite spelling is refused rather than rounded: it is
     * the number every later bound is measured against, so a value this reader
     * had to reinterpret would make those bounds meaningless. `1.0` and `1e3`
     * survive here — no parser in this family can tell them from `1` after the
     * fact — and are caught by the canonical re-encode instead.
     */
    private fun exactInt(value: Json): Long? {
        val number = (value as? Json.Num)?.value ?: return null
        if (!number.isFinite() || number != Math.floor(number)) return null
        return number.toLong()
    }

    // ── the sealed frame ────────────────────────────────────────────────────

    /**
     * Seal a manifest as a delivery's frame 0.
     *
     * The AEAD unit is the one Stored-Wire already defines — AES-256-GCM at
     * sequence 0 under the delivery's content key — and v3 changes only the
     * DOCUMENT it carries. Reusing that unit is why a v3 delivery streams
     * through the existing [com.relayium.protocol.stored.ChunkEncryptor] and
     * [com.relayium.protocol.stored.StoreDecryptor] for every frame after 0.
     */
    fun seal(contentKey: ByteArray, manifest: InboxManifestV3): ByteArray =
        Crypto.seal(storeKeySpec(contentKey), 0L, encode(manifest))

    /**
     * Open a delivery's frame 0 and decode the manifest inside it.
     *
     * The two failures are deliberately different types. An AEAD refusal is a
     * [StoredWireException], the same one every other frame in the delivery
     * raises, so a caller classifies it as the transport/authentication problem
     * it is. Everything the DOCUMENT gets wrong is an [InboxManifestException],
     * which is terminal: the seal opened, so those are the sender's own bytes and
     * every later attempt reads exactly the same ones.
     */
    fun open(contentKey: ByteArray, sealed: ByteArray): InboxManifestV3 {
        val plaintext = try {
            Crypto.open(storeKeySpec(contentKey), 0L, sealed)
        } catch (_: GeneralSecurityException) {
            throw StoredWireException(StoredWireException.Reason.TRUNCATED_STREAM)
        }
        return decode(plaintext)
    }

    private fun fail(reason: InboxManifestReason): Nothing = throw InboxManifestException(reason)
}

/** The closed content-kind set. A delivery is files or it is a message; there is
 *  no third value and no "unknown" a receiver could guess at. */
enum class InboxManifestKind(val wire: String) {
    FILE("file"),
    TEXT("text"),
    ;

    companion object {
        /** Case-SENSITIVE, like every other token on this wire. */
        fun fromWire(value: String): InboxManifestKind? = entries.firstOrNull { it.wire == value }
    }
}

/** Why a manifest was refused. A closed set rather than message text, so a caller
 *  branches on the reason and the frozen vectors pin each clause. */
enum class InboxManifestReason {
    VERSION,
    ITEM_COUNT,
    UNKNOWN_KIND,
    MIXED_KINDS,
    NAME,
    TEXT_NAME,
    TEXT_ITEM_COUNT,
    SIZE,
    TOTAL_OVERFLOW,
    MALFORMED,
    NOT_CANONICAL,
}

/** Carries the reason and nothing else: a refused manifest is peer-controlled
 *  input, and echoing a name or a fragment of it into a message is how that input
 *  reaches a log. */
class InboxManifestException(val reason: InboxManifestReason) :
    RuntimeException("relayium inbox manifest: $reason")

/**
 * One entry. [name] is present for a file and null for text — not empty, null —
 * because text has no name and a receiver must never be handed a string it could
 * be tempted to treat as a destination.
 */
data class InboxManifestItem(
    val kind: InboxManifestKind,
    val name: String?,
    val size: Long,
) {
    companion object {
        fun file(name: String, size: Long) = InboxManifestItem(InboxManifestKind.FILE, name, size)
        fun text(size: Long) = InboxManifestItem(InboxManifestKind.TEXT, null, size)
    }
}

/**
 * The whole document.
 *
 * The constructor is UNVALIDATED, like the Swift and Go equivalents: use
 * [InboxManifest.files]/[InboxManifest.text] to build one that is known to
 * satisfy every bound, or call [InboxManifest.validate].
 */
data class InboxManifestV3(val items: List<InboxManifestItem>) {

    /** The single kind of a VALID manifest. */
    val kind: InboxManifestKind? get() = items.firstOrNull()?.kind

    /** Sum of item sizes. Meaningful only on a validated manifest, where the sum
     *  is already known not to overflow. */
    val totalSize: Long get() = items.sumOf { it.size }
}
