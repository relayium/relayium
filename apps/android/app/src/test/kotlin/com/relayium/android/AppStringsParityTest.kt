package com.relayium.android

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * English and Simplified Chinese are the two maintained product languages, and
 * their coverage is a delivery requirement, not a convention: every key in the
 * source locale exists in zh-rCN and vice versa, and every placeholder set
 * matches — a `%1$s` the translation forgot would crash at format time in
 * exactly one language.
 */
class AppStringsParityTest {

    /**
     * Every string in a locale's resources, from EVERY file that holds one.
     *
     * **Discovered, not named.** This used to read `strings.xml` and nothing
     * else, which made splitting a feature's copy into its own file — the
     * ordinary way to keep two writers off one resource — a silent way out of
     * the parity gate: the new file would simply not be looked at, in either
     * language, and a missing translation would ship. The directory is the
     * source of truth now, so a file added in one language and forgotten in
     * the other is a failure rather than an absence nobody checks.
     *
     * Both locales are read the same way, so a file that exists in only one of
     * them shows up as keys present in one language and missing in the other,
     * which is exactly what the parity assertion already reports.
     */
    private fun strings(directory: String): Map<String, String> {
        val dir = File(directory)
        assertTrue("missing resource directory $directory", dir.isDirectory)
        val files = dir.listFiles { file: File -> file.name.endsWith(".xml") }.orEmpty()
            .filter { it.readText().contains("<resources") }
            .sortedBy { it.name }
        assertTrue("no resource files in $directory", files.isNotEmpty())
        val out = LinkedHashMap<String, String>()
        for (file in files) {
            val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
            val nodes = doc.getElementsByTagName("string")
            for (i in 0 until nodes.length) {
                val element = nodes.item(i) as Element
                val name = element.getAttribute("name")
                // A duplicate key across two files in one locale is an
                // ambiguity the resource compiler resolves silently and a
                // translator cannot see.
                assertTrue("duplicate key $name in $directory", !out.containsKey(name))
                out[name] = element.textContent
            }
        }
        return out
    }

    private fun placeholders(value: String): List<String> =
        Regex("%\\d+\\$[sd]").findAll(value).map { it.value }.sorted().toList()

    @Test
    fun `every key exists in both maintained languages`() {
        val en = strings("src/main/res/values")
        val zh = strings("src/main/res/values-zh-rCN")
        assertEquals(
            "keys only in one language",
            emptySet<String>(),
            (en.keys - zh.keys) + (zh.keys - en.keys),
        )
    }

    @Test
    fun `every placeholder set matches between the languages`() {
        val en = strings("src/main/res/values")
        val zh = strings("src/main/res/values-zh-rCN")
        for ((key, value) in en) {
            assertEquals(
                "placeholders differ for $key",
                placeholders(value),
                placeholders(zh.getValue(key)),
            )
        }
    }

    /**
     * The discovery itself, checked against a file it must not miss.
     *
     * Without this, the walk above could quietly stop finding a file — a
     * filter that no longer matches, a directory that moved — and every parity
     * assertion would keep passing over an ever smaller set. A gate that
     * silently narrows is worse than one that fails.
     */
    @Test
    fun `the parity walk really reads every resource file, not just the first`() {
        val en = strings("src/main/res/values")
        val zh = strings("src/main/res/values-zh-rCN")
        // One key from the app's main file and one from a feature file that
        // lives in its own XML, so a regression to "strings.xml only" fails
        // here rather than passing quietly.
        for (key in listOf("app_name", "scan_title")) {
            assertTrue("$key missing from en", en.containsKey(key))
            assertTrue("$key missing from zh", zh.containsKey(key))
        }
        assertTrue(
            "the walk found suspiciously few keys: ${en.size}",
            en.size > File("src/main/res/values").listFiles().orEmpty().size,
        )
    }

    /**
     * The negative control: the assertions above fail when they should.
     *
     * A parity test is a comparison of two maps, and a comparison that has
     * never been shown to fail is indistinguishable from one that compares
     * nothing. This builds the mismatches in memory rather than on disk, so
     * the control costs no fixture and cannot leave a broken resource behind.
     */
    @Test
    fun `a missing translation and a changed placeholder are both caught`() {
        val en = mapOf("a" to "one", "b" to "two %1\$s")
        val zhMissingKey = mapOf("a" to "一")
        assertTrue(
            "a missing key must be visible",
            ((en.keys - zhMissingKey.keys) + (zhMissingKey.keys - en.keys)).isNotEmpty(),
        )
        val zhChangedPlaceholder = mapOf("a" to "一", "b" to "二 %1\$d")
        assertTrue(
            "a changed placeholder must be visible",
            placeholders(en.getValue("b")) != placeholders(zhChangedPlaceholder.getValue("b")),
        )
        // And the same comparison agrees when the two really do match.
        val zhGood = mapOf("a" to "一", "b" to "二 %1\$s")
        assertTrue(((en.keys - zhGood.keys) + (zhGood.keys - en.keys)).isEmpty())
        assertEquals(placeholders(en.getValue("b")), placeholders(zhGood.getValue("b")))
    }

    /** Every `error_*` key the controller can emit has copy in the app. The
     *  list is the controller's, read from its source, so a new key cannot
     *  ship silently unlocalised. */
    @Test
    fun `every controller error key has localised copy`() {
        val en = strings("src/main/res/values")
        val controller = File("src/main/kotlin/com/relayium/android/TransferController.kt").readText()
        val emitted = Regex("\"(error_[a-z_]+)\"").findAll(controller).map { it.groupValues[1] }.toSet()
        assertTrue("controller emits no keys? parsing broke", emitted.isNotEmpty())
        val missing = emitted.filterNot { en.containsKey(it) }
        assertEquals("controller error keys with no copy: $missing", emptyList<String>(), missing)
    }
}
