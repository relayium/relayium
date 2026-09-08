package com.relayium.protocol.inbox

import com.relayium.protocol.Fixtures
import com.relayium.protocol.Json
import kotlin.test.assertFailsWith
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The v3 manifest codec against `device-inbox-manifest-v3-vectors.json` — the
 * same frozen file the Go, TypeScript and Swift codecs assert on.
 *
 * These bytes are the interoperability contract. A manifest that serialises one
 * space differently, escapes a character the others emit raw, or accepts a name
 * the others refuse produces a delivery this client would round-trip with itself
 * and no other client could read — or, worse, one every other client refuses to
 * write to disk while this one writes it.
 */
class InboxManifestVectorTest {

    private val v = InboxFixtures.manifestVectors

    /**
     * Each fixture token, mapped to the reason this implementation must raise.
     * Written out rather than derived, so a vector carrying a new token fails
     * loudly instead of silently matching nothing.
     */
    private val reasons = mapOf(
        "version" to InboxManifestReason.VERSION,
        "itemCount" to InboxManifestReason.ITEM_COUNT,
        "unknownKind" to InboxManifestReason.UNKNOWN_KIND,
        "mixedKinds" to InboxManifestReason.MIXED_KINDS,
        "name" to InboxManifestReason.NAME,
        "textName" to InboxManifestReason.TEXT_NAME,
        "textItemCount" to InboxManifestReason.TEXT_ITEM_COUNT,
        "size" to InboxManifestReason.SIZE,
        "totalOverflow" to InboxManifestReason.TOTAL_OVERFLOW,
        "malformed" to InboxManifestReason.MALFORMED,
        "notCanonical" to InboxManifestReason.NOT_CANONICAL,
    )

    private fun reason(token: String): InboxManifestReason =
        reasons[token] ?: error("vector uses reason \"$token\", which this test does not map")

    private fun optionalNumber(value: Json?): Long? = (value as? Json.Num)?.value?.toLong()

    private fun items(entry: Json.Obj): List<InboxManifestItem> =
        (entry["items"] as Json.Arr).items.map { raw ->
            val item = raw as Json.Obj
            val kindText = Fixtures.string(item["kind"])
            InboxManifestItem(
                kind = InboxManifestKind.fromWire(kindText) ?: error("fixture kind $kindText"),
                name = Fixtures.optionalString(item["name"]),
                size = Fixtures.number(item["size"]),
            )
        }

    /** The constants before the documents: a bound that drifted here would make
     *  every vector below pass against the wrong rule. */
    @Test
    fun `bounds match the frozen fixture`() {
        assertEquals(InboxManifest.VERSION.toLong(), Fixtures.num(v, "version"))
        assertEquals(InboxManifest.MAX_ITEMS.toLong(), Fixtures.num(v, "bounds", "maxItems"))
        assertEquals(InboxManifest.MIN_ITEMS.toLong(), Fixtures.num(v, "bounds", "minItems"))
        assertEquals(InboxManifest.MAX_NAME_BYTES.toLong(), Fixtures.num(v, "bounds", "maxNameBytes"))
        assertEquals(InboxManifest.MAX_PATH_DEPTH.toLong(), Fixtures.num(v, "bounds", "maxPathDepth"))
        assertEquals(InboxManifest.MAX_SAFE_INTEGER, Fixtures.num(v, "bounds", "maxSafeInteger"))
        assertEquals(InboxManifest.MIN_TEXT_BYTES, Fixtures.num(v, "bounds", "minTextBytes"))
        assertEquals(InboxManifest.MAX_TEXT_BYTES, Fixtures.num(v, "bounds", "maxTextBytes"))
    }

    @Test
    fun `every accept vector decodes to its stated shape and re-encodes to its exact bytes`() {
        val vectors = Fixtures.arr(v, "accept")
        assertTrue("no accept vectors were loaded", vectors.isNotEmpty())
        for (raw in vectors) {
            val entry = raw as Json.Obj
            val name = Fixtures.string(entry["name"])
            val canonical = Fixtures.string(entry["canonical"]).toByteArray(Charsets.UTF_8)
            val expected = items(entry)

            val decoded = InboxManifest.decode(canonical)
            assertEquals(name, expected, decoded.items)
            assertEquals(name, Fixtures.string(entry["kind"]), decoded.kind?.wire)
            assertEquals(name, Fixtures.number(entry["total"]), decoded.totalSize)
            // ENCODE too. Decoding alone would let a lenient encoder pass.
            assertArrayEquals(name, canonical, InboxManifest.encode(InboxManifestV3(expected)))
        }
    }

    @Test
    fun `every refuse vector is refused, with the named clause`() {
        val vectors = Fixtures.arr(v, "refuse")
        assertTrue("no refuse vectors were loaded", vectors.isNotEmpty())
        for (raw in vectors) {
            val entry = raw as Json.Obj
            val name = Fixtures.string(entry["name"])
            val document = Fixtures.string(entry["json"]).toByteArray(Charsets.UTF_8)
            val thrown = assertFailsWith<InboxManifestException>(name) {
                InboxManifest.decode(document)
            }
            // `anyRefusal` vectors are ones the JSON parsers of this family
            // cannot all observe identically — JavaScript cannot tell 1.0 from 1
            // after parsing, Go cannot tell an absent key from a zero value. They
            // must still be REFUSED; only the clause may differ.
            if (Fixtures.optionalBool(entry["anyRefusal"]) == true) continue
            assertEquals(name, reason(Fixtures.string(entry["reason"])), thrown.reason)
        }
    }

    /** The bounds that would make the fixture enormous if spelled out — a
     *  thousand items, a kilobyte name, a sixty-four-deep path — built from the
     *  same frozen numbers. */
    @Test
    fun `every generated vector lands on the right side of its bound`() {
        val vectors = Fixtures.arr(v, "generated")
        assertTrue("no generated vectors were loaded", vectors.isNotEmpty())
        for (raw in vectors) {
            val entry = raw as Json.Obj
            val name = Fixtures.string(entry["name"])
            val count = optionalNumber(entry["count"])
            val nameBytes = optionalNumber(entry["nameBytes"])
            val depth = optionalNumber(entry["depth"])
            val manifest = when {
                count != null -> InboxManifestV3(List(count.toInt()) { InboxManifestItem.file("f", 1) })
                nameBytes != null ->
                    InboxManifestV3(listOf(InboxManifestItem.file("a".repeat(nameBytes.toInt()), 1)))
                depth != null ->
                    InboxManifestV3(listOf(InboxManifestItem.file("a/".repeat(depth.toInt() - 1) + "b", 1)))
                else -> error("generated vector \"$name\" describes nothing to build")
            }

            val token = Fixtures.string(entry["reason"])
            if (token == "accept") {
                InboxManifest.validate(manifest)
                // Round-trips too: a bound only `validate` honours would still
                // break a real delivery at encode or decode time.
                assertEquals(name, manifest, InboxManifest.decode(InboxManifest.encode(manifest)))
                continue
            }
            val thrown = assertFailsWith<InboxManifestException>(name) {
                InboxManifest.validate(manifest)
            }
            assertEquals(name, reason(token), thrown.reason)
        }
    }
}
